# siavash/ml.py
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Literal, Optional, Tuple

import numpy as np
import rasterio
import warnings

from sklearn.ensemble import RandomForestRegressor
from sklearn.inspection import permutation_importance
from sklearn.metrics import mean_squared_error, make_scorer
from sklearn.model_selection import GroupKFold, KFold, RandomizedSearchCV

from scipy.stats import randint, uniform

Logger = Callable[[str], None]

CVMode = Literal["pixel", "block"]
PruneMethod = Literal["importance", "correlation"]


@dataclass
class PruningOptions:
    method: PruneMethod = "importance"
    random_seed: int = 0
    corr_cap: int = 300_000
    perm_cap: int = 250_000
    thresh_tree: float = 0.95
    thresh_nn: float = 0.80
    never_drop: Tuple[str, ...] = ()
    importance_ref_label: str = "30"


@dataclass
class XGBOptions:
    cv_mode: CVMode = "pixel"
    n_splits: int = 5
    block_size: int = 40
    random_state: int = 42

    n_iter: int = 30
    max_train_pixels: Optional[int] = None
    predict_chunk_size: int = 1_000_000

    min_wet: float = 0.05
    h1: float = 0.50
    h2: float = 2.00

    nodata_f32: float = -9999.0
    nodata_u8: int = 255  # keep 0 meaning "no hazard"; use 255 for nodata


@dataclass
class MLOutputs:
    out_dir: str
    predictors_used: List[str] = field(default_factory=list)
    pruning: Dict[str, Any] = field(default_factory=dict)

    xgb_models: Dict[str, str] = field(default_factory=dict)
    depth_rasters: Dict[str, str] = field(default_factory=dict)
    hazard_rasters: Dict[str, str] = field(default_factory=dict)

    # float32: ARI value where high/red first appears; 0=none (inside AOI), nodata=-9999 outside AOI
    composite_high_red: Optional[str] = None


@dataclass(frozen=True)
class RasterGrid:
    crs_wkt: str
    transform: Tuple[float, float, float, float, float, float]
    height: int
    width: int


def _grid_from_dataset(ds: rasterio.io.DatasetReader) -> RasterGrid:
    if ds.crs is None:
        raise ValueError("Raster CRS is missing.")
    t = ds.transform
    return RasterGrid(
        crs_wkt=ds.crs.to_wkt(),
        transform=(t.a, t.b, t.c, t.d, t.e, t.f),
        height=ds.height,
        width=ds.width,
    )


def _grids_equal(g1: RasterGrid, g2: RasterGrid, atol: float = 1e-6) -> bool:
    if g1.crs_wkt != g2.crs_wkt:
        return False
    if g1.height != g2.height or g1.width != g2.width:
        return False
    return np.allclose(np.array(g1.transform), np.array(g2.transform), atol=atol)


def load_single_band_float32(path: str) -> Tuple[np.ndarray, RasterGrid, float | None]:
    with rasterio.open(path) as src:
        arr = src.read(1).astype("float32")
        nod = src.nodata
        grid = _grid_from_dataset(src)

    if nod is not None and np.isfinite(float(nod)):
        arr = np.where(arr == float(nod), np.nan, arr)
    else:
        arr = np.where(~np.isfinite(arr), np.nan, arr)

    return arr, grid, nod

def _safe_remove(path: str | Path) -> None:
    p = Path(path)
    try:
        if p.exists():
            p.unlink()
    except PermissionError:
        raise
    except Exception:
        pass


def _sanitize_meta_for_write(meta: dict) -> dict:
    """
    Avoid inherited tiling/block sizes that can fail for small AOIs.
    """
    meta = meta.copy()
    for k in ("tiled", "blockxsize", "blockysize", "interleave"):
        meta.pop(k, None)
    return meta

def _write_float32_like(template_path: str, out_path: str, arr: np.ndarray, *, nodata: float) -> str:
    with rasterio.open(template_path) as src:
        meta = _sanitize_meta_for_write(src.meta.copy())

    meta.update(driver="GTiff", dtype="float32", count=1, nodata=float(nodata), compress="lzw")
    out_path = str(out_path)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)

    data = np.where(np.isfinite(arr), arr.astype("float32"), float(nodata)).astype("float32")
    _safe_remove(out_path)
    with rasterio.open(out_path, "w", **meta) as dst:
        dst.write(data, 1)
    return out_path


def _write_uint8_like(template_path: str, out_path: str, arr_u8: np.ndarray, *, nodata: int) -> str:
    with rasterio.open(template_path) as src:
        meta = _sanitize_meta_for_write(src.meta.copy())

    meta.update(driver="GTiff", dtype="uint8", count=1, nodata=int(nodata), compress="lzw")
    out_path = str(out_path)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    _safe_remove(out_path)

    with rasterio.open(out_path, "w", **meta) as dst:
        dst.write(arr_u8.astype("uint8"), 1)
    return out_path


def _normalize_rp_dict(d: Any) -> Dict[int, str]:
    """
    Robustly parse RP->path dicts that may have int keys (in-memory) or str keys (JSON reload).
    """
    out: Dict[int, str] = {}
    if not isinstance(d, dict):
        return out
    for k, v in d.items():
        if not isinstance(v, str):
            continue
        try:
            out[int(k)] = v
        except Exception:
            continue
    return out

def _add_unique_path(paths: Dict[str, str], name: str, fp: Any, seen: set[str]) -> None:
    if not isinstance(fp, str):
        return
    p = Path(fp)
    key = str(p.resolve()) if p.exists() else str(p)
    if key in seen:
        return
    seen.add(key)
    paths[name] = fp


def collect_default_predictor_paths(
    pipeline_outputs: Dict[str, Any],
    *,
    include_lulc: bool = False,
    include_exposure: bool = False,
) -> Dict[str, str]:
    """
    Returns a flat {predictor_name: path} map.

    - Hydro: accepts both canonical keys and legacy aliases, but keeps only
      one predictor per unique raster path.
    - Satellite: keeps current numeric layers; can optionally include categorical lulc.
    - Exposure: optional (population/nightlights/builtup/buildings).
    """
    paths: Dict[str, str] = {}
    seen_paths: set[str] = set()

    hyd = pipeline_outputs.get("hydro") or {}
    for k in ("dem_filled", "twi", "logflowacc", "flowacc", "flow_accum_log", "flow_accum"):
        _add_unique_path(paths, k, hyd.get(k), seen_paths)

    terr = pipeline_outputs.get("terrain") or {}
    for k in ("slope", "aspect", "trasp", "plan_curvature"):
        _add_unique_path(paths, k, terr.get(k), seen_paths)

    lf = pipeline_outputs.get("linear_features") or {}
    for k in ("road_distance", "river_distance", "river_density"):
        _add_unique_path(paths, k, lf.get(k), seen_paths)

    sat = pipeline_outputs.get("satellite") or {}
    for k in ("manning", "ndvi", "rainfall", "spi", "hsg", "hand"):
        _add_unique_path(paths, k, sat.get(k), seen_paths)

    if include_lulc:
        _add_unique_path(paths, "lulc", sat.get("lulc"), seen_paths)

    if include_exposure:
        exp = pipeline_outputs.get("exposure") or {}
        for k in ("population", "nightlights", "builtup", "buildings"):
            _add_unique_path(paths, k, exp.get(k), seen_paths)

    return paths


def collect_default_targets(
    pipeline_outputs: Dict[str, Any],
    *,
    targets: Tuple[int, ...] = (30, 100, 300, 1000),
) -> Dict[str, str]:
    flood = pipeline_outputs.get("flood") or {}
    glofas = _normalize_rp_dict(flood.get("glofas"))
    gumbel = _normalize_rp_dict(flood.get("gumbel"))

    out: Dict[str, str] = {}
    for T in targets:
        fp = gumbel.get(int(T)) or glofas.get(int(T))
        if not fp:
            raise FileNotFoundError(f"Target flood depth for RP={T} not found in pipeline outputs.")
        out[str(T)] = fp
    return out


def load_predictors(
    predictor_paths: Dict[str, str], *, logger: Optional[Logger] = None
) -> Tuple[Dict[str, np.ndarray], str]:
    feature_arrays: Dict[str, np.ndarray] = {}
    template_path: Optional[str] = None
    grid0: Optional[RasterGrid] = None

    for name, fp in predictor_paths.items():
        if not fp or not Path(fp).exists():
            if logger:
                logger(f"⚠ predictor missing (skipped): {name} -> {fp}")
            continue

        arr, grid, _ = load_single_band_float32(fp)

        if grid0 is None:
            grid0 = grid
            template_path = fp
        else:
            if not _grids_equal(grid0, grid):
                raise ValueError(f"Predictor '{name}' grid mismatch vs first predictor.")

        feature_arrays[name] = arr

    if not feature_arrays or template_path is None:
        raise RuntimeError("No predictors could be loaded.")

    if logger:
        logger(f"✓ Loaded {len(feature_arrays)} predictors: " + ", ".join(feature_arrays.keys()))
    return feature_arrays, template_path


def build_design_matrix(feature_arrays: Dict[str, np.ndarray]) -> Tuple[int, int, np.ndarray, np.ndarray, List[str]]:
    names = list(feature_arrays.keys())
    stack = np.stack([feature_arrays[n] for n in names], axis=-1)  # (H,W,P)
    rows, cols = stack.shape[0], stack.shape[1]

    flat = stack.reshape(-1, stack.shape[-1])
    valid = np.isfinite(flat).all(axis=1)

    X_flat = flat[valid].astype("float32")
    return rows, cols, X_flat, valid, names


def _spatial_groups(rows: int, cols: int, valid_mask_flat: np.ndarray, block_size: int) -> np.ndarray:
    rr, cc = np.indices((rows, cols))
    grp = (rr // block_size) * 100000 + (cc // block_size)
    return grp.reshape(-1)[valid_mask_flat]


def prune_features(
    feature_arrays: Dict[str, np.ndarray],
    target_path_for_importance: Optional[str],
    *,
    opts: PruningOptions,
    logger: Optional[Logger] = None,
) -> Dict[str, Any]:
    rng = np.random.RandomState(opts.random_seed)
    names = list(feature_arrays.keys())
    P = len(names)
    never_drop = set(opts.never_drop)

    if P < 2:
        return {
            "method": opts.method,
            "keep_tree": names,
            "drop_tree": [],
            "keep_nn": names,
            "drop_nn": [],
            "importance": None,
        }

    stack = np.stack([feature_arrays[n] for n in names], axis=-1)
    flat = stack.reshape(-1, P)
    valid_pred = np.isfinite(flat).all(axis=1)

    y_full = None
    valid_all = valid_pred
    if opts.method == "importance":
        if not target_path_for_importance:
            raise ValueError("importance pruning requested but no target raster provided.")
        y_arr, _, _ = load_single_band_float32(target_path_for_importance)
        y_full = y_arr.reshape(-1)
        valid_all = valid_pred & np.isfinite(y_full)

    X_full = flat[valid_all].astype("float32")
    y_fit = y_full[valid_all].astype("float32") if opts.method == "importance" else None  # type: ignore[index]

    if opts.corr_cap and X_full.shape[0] > opts.corr_cap:
        idx = rng.choice(X_full.shape[0], size=opts.corr_cap, replace=False)
        X_corr = X_full[idx]
    else:
        X_corr = X_full

    C = np.corrcoef(X_corr, rowvar=False)
    C = np.nan_to_num(C, nan=0.0, posinf=0.0, neginf=0.0)
    upper = np.triu(np.abs(C), k=1)

    importance = None
    if opts.method == "importance":
        if opts.perm_cap and X_full.shape[0] > opts.perm_cap:
            idx = rng.choice(X_full.shape[0], size=opts.perm_cap, replace=False)
            X_rank = X_full[idx]
            y_rank = y_fit[idx]  # type: ignore[index]
        else:
            X_rank = X_full
            y_rank = y_fit  # type: ignore[assignment]

        rf = RandomForestRegressor(n_estimators=250, random_state=opts.random_seed, n_jobs=-1)
        rf.fit(X_rank, y_rank)

        try:
            perm = permutation_importance(rf, X_rank, y_rank, n_repeats=5, random_state=opts.random_seed, n_jobs=-1)
            imp = perm.importances_mean
            if logger:
                logger("✓ pruning importance: permutation")
        except Exception:
            imp = rf.feature_importances_
            if logger:
                logger("⚠ pruning importance: permutation failed; using impurity")

        importance = {n: float(v) + 1e-12 for n, v in zip(names, imp)}

    def components(thresh: float) -> List[List[int]]:
        adj = [[] for _ in range(P)]
        for i in range(P):
            for j in range(i + 1, P):
                if upper[i, j] >= thresh:
                    adj[i].append(j)
                    adj[j].append(i)

        seen = np.zeros(P, dtype=bool)
        comps: List[List[int]] = []
        for i in range(P):
            if seen[i]:
                continue
            q = [i]
            seen[i] = True
            comp = []
            while q:
                u = q.pop()
                comp.append(u)
                for v in adj[u]:
                    if not seen[v]:
                        seen[v] = True
                        q.append(v)
            comps.append(comp)
        return comps

    def select(thresh: float) -> Tuple[List[str], List[str]]:
        comps = components(thresh)
        drop_idx: set[int] = set()

        scores = np.array([importance[n] for n in names], dtype=float) if importance is not None else np.nanvar(X_full, axis=0)

        for comp in comps:
            if len(comp) <= 1:
                continue
            keep = max(comp, key=lambda ix: float(scores[ix]))
            for ix in comp:
                if ix != keep:
                    drop_idx.add(ix)

        drop_names = [names[ix] for ix in sorted(drop_idx) if names[ix] not in never_drop]
        keep_names = [n for n in names if n not in set(drop_names)]
        return keep_names, drop_names

    keep_tree, drop_tree = select(opts.thresh_tree)
    keep_nn, drop_nn = select(opts.thresh_nn)

    if logger:
        logger(f"✓ pruning done: TREE keep={len(keep_tree)} drop={len(drop_tree)} | NN keep={len(keep_nn)} drop={len(drop_nn)}")

    return {
        "method": opts.method,
        "keep_tree": keep_tree,
        "drop_tree": drop_tree,
        "keep_nn": keep_nn,
        "drop_nn": drop_nn,
        "importance": importance,
    }


def _require_xgboost():
    try:
        from xgboost import XGBRegressor  # noqa: F401
    except Exception as e:
        raise ModuleNotFoundError("xgboost is required. Install: conda install -c conda-forge xgboost") from e


def _rmse(y, yhat) -> float:
    return float(np.sqrt(mean_squared_error(y, yhat)))


def build_high_hazard_composite(
    hazard_rasters: Dict[str, str],
    *,
    template_raster_for_writing: str,
    out_path: str,
    valid_mask_2d: np.ndarray,
    class_high: int = 3,
    none_value: float = 0.0,
    nodata_value: float = -9999.0,
) -> str:
    """
    float32 composite:
      - inside AOI/valid footprint:
          earliest ARI value where hazard==class_high, else none_value (0)
      - outside AOI/valid footprint:
          nodata_value (-9999)
    """
    def _ari(lbl: str) -> int:
        return int(lbl)

    labels = sorted(hazard_rasters.keys(), key=_ari)
    if not labels:
        raise RuntimeError("No hazard rasters provided for composite.")

    layers = []
    for lbl in labels:
        hz, _, _ = load_single_band_float32(hazard_rasters[lbl])  # nodata=255 => NaN here
        ari_val = float(_ari(lbl))
        layers.append(np.where(hz == float(class_high), ari_val, np.nan).astype("float32"))

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        comp = np.nanmin(np.stack(layers, axis=0), axis=0)  # NaN where never high

    comp = np.where(np.isfinite(comp), comp, float(none_value)).astype("float32")

    # enforce footprint nodata
    comp = np.where(valid_mask_2d, comp, float(nodata_value)).astype("float32")

    return _write_float32_like(template_raster_for_writing, out_path, comp, nodata=float(nodata_value))


def train_xgb_depth_hazard(
    *,
    feature_arrays: Dict[str, np.ndarray],
    template_raster_for_writing: str,
    targets: Dict[str, str],
    out_dir: str | Path,
    xgb_opts: XGBOptions,
    save_models: bool = True,
    logger: Optional[Logger] = None,
) -> MLOutputs:
    _require_xgboost()
    from xgboost import XGBRegressor

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows, cols, X_flat, valid_mask_flat, names = build_design_matrix(feature_arrays)
    valid2d = valid_mask_flat.reshape(rows, cols)

    if logger:
        logger(f"✓ design matrix: {X_flat.shape[0]:,} px × {X_flat.shape[1]} predictors")

    with rasterio.open(template_raster_for_writing) as tds:
        grid_x = _grid_from_dataset(tds)

    base_splitter = (
        KFold(n_splits=xgb_opts.n_splits, shuffle=True, random_state=xgb_opts.random_state)
        if xgb_opts.cv_mode == "pixel"
        else GroupKFold(n_splits=xgb_opts.n_splits)
    )

    groups_full = _spatial_groups(rows, cols, valid_mask_flat, xgb_opts.block_size) if xgb_opts.cv_mode == "block" else None

    param_dist = {
        "n_estimators": randint(200, 600),
        "max_depth": randint(4, 12),
        "learning_rate": uniform(0.01, 0.19),
        "subsample": uniform(0.6, 0.4),
        "colsample_bytree": uniform(0.6, 0.4),
        "min_child_weight": uniform(1, 9),
    }
    rmse_scorer = make_scorer(lambda y, yhat: _rmse(y, yhat), greater_is_better=False)

    outputs = MLOutputs(out_dir=str(out_dir), predictors_used=names)

    model_paths: Dict[str, str] = {}
    if save_models:
        try:
            import joblib  # type: ignore
        except Exception:
            save_models = False
            if logger:
                logger("⚠ joblib not installed → models will not be saved.")

    for label, depth_fp in targets.items():
        if logger:
            logger(f"▶ XGB {label}: loading target depth raster …")

        y_arr, grid_y, _ = load_single_band_float32(depth_fp)
        if not _grids_equal(grid_x, grid_y):
            raise ValueError(f"Target '{label}' grid does not match predictors/template grid.")

        y_flat_all = y_arr.reshape(-1)[valid_mask_flat]
        good_tgt = np.isfinite(y_flat_all)

        X_fit = X_flat[good_tgt]
        y_fit = y_flat_all[good_tgt].astype("float32")

        groups_fit = groups_full[good_tgt] if groups_full is not None else None

        if xgb_opts.max_train_pixels and X_fit.shape[0] > xgb_opts.max_train_pixels:
            rng = np.random.RandomState(xgb_opts.random_state)
            idx = rng.choice(X_fit.shape[0], size=int(xgb_opts.max_train_pixels), replace=False)
            X_fit = X_fit[idx]
            y_fit = y_fit[idx]
            if groups_fit is not None:
                groups_fit = groups_fit[idx]
            if logger:
                logger(f"   • train cap: using {X_fit.shape[0]:,} samples")

        base = XGBRegressor(
            objective="reg:squarederror",
            tree_method="hist",
            n_jobs=-1,
            random_state=xgb_opts.random_state,
        )

        splits = (
            list(base_splitter.split(X_fit, y_fit, groups_fit))
            if groups_fit is not None
            else list(base_splitter.split(X_fit, y_fit))
        )

        if logger:
            logger(f"   • tuning (n_iter={xgb_opts.n_iter}) with {xgb_opts.cv_mode} CV …")

        search = RandomizedSearchCV(
            estimator=base,
            param_distributions=param_dist,
            n_iter=int(xgb_opts.n_iter),
            scoring={"rmse": rmse_scorer, "r2": "r2"},
            refit="rmse",
            cv=splits,
            n_jobs=-1,
            verbose=0,
            random_state=xgb_opts.random_state,
            return_train_score=False,
        )
        search.fit(X_fit, y_fit)

        best = search.best_estimator_

        ix_best = search.best_index_
        rmse_folds = [-search.cv_results_[f"split{k}_test_rmse"][ix_best] for k in range(xgb_opts.n_splits)]
        r2_folds = [search.cv_results_[f"split{k}_test_r2"][ix_best] for k in range(xgb_opts.n_splits)]

        if logger:
            logger(
                f"   → CV RMSE {np.mean(rmse_folds):.3f} ± {np.std(rmse_folds):.3f} | "
                f"R² {np.mean(r2_folds):.3f} ± {np.std(r2_folds):.3f}"
            )
            logger(f"     best params: {search.best_params_}")
            logger("   • predicting full grid (chunked) …")

        n_valid = X_flat.shape[0]
        y_pred = np.empty(n_valid, dtype="float32")
        cs = int(max(10_000, xgb_opts.predict_chunk_size))
        for i0 in range(0, n_valid, cs):
            i1 = min(n_valid, i0 + cs)
            y_pred[i0:i1] = best.predict(X_flat[i0:i1]).astype("float32")

        cont_flat = np.full(rows * cols, np.nan, dtype="float32")
        cont_flat[valid_mask_flat] = y_pred
        cont = cont_flat.reshape(rows, cols)

        cont = np.where(cont < float(xgb_opts.min_wet), np.nan, cont)

        haz = np.zeros((rows, cols), dtype="uint8")
        finite = np.isfinite(cont)
        haz[finite & (cont < float(xgb_opts.h1))] = 1
        haz[finite & (cont >= float(xgb_opts.h1)) & (cont < float(xgb_opts.h2))] = 2
        haz[finite & (cont >= float(xgb_opts.h2))] = 3

        haz[~valid2d] = np.uint8(xgb_opts.nodata_u8)

        depth_out = out_dir / f"xgb_depth_{label}.tif"
        haz_out = out_dir / f"xgb_hazard_{label}.tif"

        _write_float32_like(template_raster_for_writing, str(depth_out), cont, nodata=float(xgb_opts.nodata_f32))
        _write_uint8_like(template_raster_for_writing, str(haz_out), haz, nodata=int(xgb_opts.nodata_u8))

        outputs.depth_rasters[label] = str(depth_out)
        outputs.hazard_rasters[label] = str(haz_out)

        if save_models:
            import joblib  # type: ignore
            mp = out_dir / f"xgb_model_{label}.joblib"
            joblib.dump(best, mp)
            model_paths[label] = str(mp)

        if logger:
            logger(f"   ✓ saved: {depth_out.name}, {haz_out.name}")

    outputs.xgb_models = model_paths

    outputs.composite_high_red = build_high_hazard_composite(
        outputs.hazard_rasters,
        template_raster_for_writing=template_raster_for_writing,
        out_path=str(out_dir / "xgb_hazard_composite_high_red.tif"),
        valid_mask_2d=valid2d,
        class_high=3,
        none_value=0.0,
        nodata_value=float(xgb_opts.nodata_f32),
    )

    if logger and outputs.composite_high_red:
        logger(f"✓ composite saved: {Path(outputs.composite_high_red).name}")

    return outputs


def run_section7_ml_xgb(
    pipeline_result: Any,
    *,
    out_subdir: str = "predictors/ml_xgb",
    extra_predictors: Optional[Dict[str, str]] = None,
    target_return_periods: Tuple[int, ...] = (30, 100, 300, 1000),
    pruning: Optional[PruningOptions] = None,
    xgb: Optional[XGBOptions] = None,
    do_prune: bool = True,
    save_models: bool = True,
    logger: Optional[Logger] = None,
) -> MLOutputs:
    outputs = getattr(pipeline_result, "outputs", None)
    run_dir = getattr(pipeline_result, "run_dir", None)
    if not isinstance(outputs, dict) or not isinstance(run_dir, str):
        raise TypeError("pipeline_result must be a PipelineResult-like object with .run_dir and .outputs")

    pruning = pruning or PruningOptions()
    xgb = xgb or XGBOptions()

    out_dir = Path(run_dir) / out_subdir
    out_dir.mkdir(parents=True, exist_ok=True)

    pred_paths = collect_default_predictor_paths(outputs)
    if extra_predictors:
        pred_paths.update(extra_predictors)

    feature_arrays, template_path = load_predictors(pred_paths, logger=logger)
    target_paths = collect_default_targets(outputs, targets=target_return_periods)

    if do_prune:
        ref_label = pruning.importance_ref_label
        ref_target = target_paths.get(ref_label) or next(iter(target_paths.values()))
        pr_pack = prune_features(feature_arrays, ref_target, opts=pruning, logger=logger)
        keep = pr_pack["keep_tree"]
        feature_arrays = {k: feature_arrays[k] for k in keep}
        if logger:
            logger("✓ predictors after pruning: " + ", ".join(list(feature_arrays.keys())))
    else:
        pr_pack = {"method": "none"}

    ml = train_xgb_depth_hazard(
        feature_arrays=feature_arrays,
        template_raster_for_writing=template_path,
        targets=target_paths,
        out_dir=out_dir,
        xgb_opts=xgb,
        save_models=save_models,
        logger=logger,
    )
    ml.pruning = pr_pack
    return ml
