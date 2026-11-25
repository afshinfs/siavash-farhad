"""Train flood-depth models using the desktop predictor selection and XGBoost search."""
from pathlib import Path
import math

import numpy as np
import rasterio
import sklearn
import xgboost
from sklearn.model_selection import GroupKFold, KFold, ParameterSampler
from xgboost import XGBRegressor

from ml import (
    PruningOptions,
    build_design_matrix,
    prune_features,
    xgb_parameter_distributions,
    _spatial_groups,
    _write_float32_like,
)


MODEL_OPTIONS = dict(objective="reg:squarederror", tree_method="hist", n_jobs=1, random_state=42)
SEARCH_TRIALS = 30
WET_DEPTH = np.float32(0.05)


def read_grid_layer(path, expected=None):
    with rasterio.open(path) as raster:
        if raster.count != 1 or raster.crs is None:
            raise ValueError(f"{Path(path).stem} requires a single band and a CRS.")
        grid = (raster.crs, raster.shape, tuple(raster.transform)[:6])
        if expected is not None and (
            grid[:2] != expected[:2] or not np.allclose(grid[2], expected[2], atol=1e-6, rtol=0)
        ):
            raise ValueError(f"{Path(path).stem} does not match the DEM grid.")
        try:
            values = raster.read(1, masked=True).astype("float32").filled(np.nan)
        except rasterio.errors.RasterioIOError as error:
            raise ValueError(f"Training could not read {Path(path).stem}. Run Check raster stack again.") from error
    return values, grid


def scores(observed, predicted):
    observed = observed.astype(np.float64)
    squared_error = np.square(observed - predicted).sum()
    total = np.square(observed - observed.mean()).sum()
    return {"rmseM": math.sqrt(squared_error / len(observed)),
            "r2": float(1 - squared_error / total) if total > 0 else None}


def predict_depth(model, x):
    predicted = model.predict(x)
    if not np.isfinite(predicted).all():
        raise ValueError("XGBoost produced a non-finite depth.")
    return predicted


def train_depth_models(folder, predictors, targets, block_size, progress, *, fold_count=5, cv_mode="pixel"):
    if fold_count not in (4, 5):
        raise ValueError("Select four or five spatial folds.")
    if cv_mode not in ("pixel", "block"):
        raise ValueError("Select pixel or spatial block cross-validation.")
    root = Path(folder)
    dem_path = root / "dem.tif"
    dem, grid = read_grid_layer(dem_path)
    dem_mask = np.isfinite(dem)
    features = {}
    for name in predictors:
        values, _ = read_grid_layer(root / f"{name}.tif", grid)
        features[name] = np.where(dem_mask, values, np.nan)
    pruning_options = PruningOptions()
    reference = next(target for target in targets if int(target["period"]) == 30)
    progress("Ranking predictors against the 30-year reference and pruning correlated layers…")
    pruning = prune_features(
        features, str(root / f'{reference["name"]}.tif'), opts=pruning_options,
        n_jobs=1, logger=progress,
    )
    features = {name: features[name] for name in pruning["keep_tree"]}
    rows, cols, x, valid, names = build_design_matrix(features)
    if not valid.any():
        raise ValueError("The predictors have no joint valid cells.")
    groups = _spatial_groups(rows, cols, valid, block_size)
    results = []

    for target in targets:
        period, name = int(target["period"]), target["name"]
        depth, _ = read_grid_layer(root / f"{name}.tif", grid)
        if np.any(dem_mask & np.isfinite(depth) & (depth < 0)):
            raise ValueError(f"The {period}-year target contains negative depths.")
        target_values = depth.ravel()[valid]
        eligible = np.isfinite(target_values)
        x_fit, y_fit, fit_groups = x[eligible], target_values[eligible], groups[eligible]
        block_count = int(np.unique(fit_groups).size)
        if len(y_fit) < fold_count:
            raise ValueError(f"The {period}-year target needs at least {fold_count} eligible cells.")
        if cv_mode == "block":
            if block_count < fold_count:
                raise ValueError(f"The {period}-year target needs at least {fold_count} occupied spatial blocks.")
            splits = list(GroupKFold(n_splits=fold_count).split(x_fit, y_fit, fit_groups))
        else:
            splits = list(KFold(n_splits=fold_count, shuffle=True, random_state=42).split(x_fit))

        candidates = ParameterSampler(xgb_parameter_distributions(), SEARCH_TRIALS, random_state=42)
        best_rmse = math.inf
        best_parameters = None
        best_predictions = None
        best_folds = None
        for trial, parameters in enumerate(candidates, 1):
            progress(f"{period:,}-year model · tuning combination {trial} of {SEARCH_TRIALS}")
            oof = np.empty_like(y_fit)
            fold_scores = []
            for fold, (train, test) in enumerate(splits, 1):
                model = XGBRegressor(**MODEL_OPTIONS, **parameters).fit(x_fit[train], y_fit[train])
                predicted = predict_depth(model, x_fit[test])
                oof[test] = predicted
                fold_scores.append({
                    "fold": fold, "trainCells": len(train), "testCells": len(test),
                    "testBlocks": ([int(value) for value in np.unique(fit_groups[test])]
                                   if cv_mode == "block" else None),
                    **scores(y_fit[test], predicted),
                })
            mean_rmse = sum(score["rmseM"] for score in fold_scores) / len(splits)
            if mean_rmse < best_rmse:
                best_rmse = mean_rmse
                best_parameters = parameters
                best_predictions = oof
                best_folds = fold_scores

        progress(f"{period:,}-year model · refitting the selected parameters and exporting depth")
        final = XGBRegressor(**MODEL_OPTIONS, **best_parameters).fit(x_fit, y_fit)
        # A finite target, including zero, establishes reference coverage.
        # Predict only inside that coverage. NoData can represent an exclusion.
        prediction_cells = np.flatnonzero(valid)[eligible]
        prediction = np.concatenate([
            predict_depth(final, x_fit[i:i + 32768])
            for i in range(0, len(x_fit), 32768)
        ])
        output = np.full(rows * cols, np.nan, dtype=np.float32)
        wet = prediction >= WET_DEPTH
        output[prediction_cells] = np.where(wet, prediction, np.nan)
        _write_float32_like(dem_path, root / f"xgb_depth_{period}.tif", output.reshape(rows, cols), nodata=-9999)
        # Retain dry depths within the reference support for downstream analysis.
        output[prediction_cells] = np.maximum(prediction, 0)
        _write_float32_like(dem_path, root / f"xgb_analysis_{period}.tif", output.reshape(rows, cols), nodata=-9999)
        final.get_booster().save_model(root / f"xgb_model_{period}.json")
        results.append({
            "period": period, "targetCells": len(y_fit), "occupiedBlocks": block_count,
            "predictionCells": len(prediction), "predictionCellsWithoutReference": 0,
            "excludedPredictorCellsWithoutReference": int((~eligible).sum()),
            "dryReferenceCells": int((y_fit < WET_DEPTH).sum()),
            "wetPredictionCells": int(wet.sum()),
            "bestParameters": {key: value.item() if isinstance(value, np.generic) else value
                               for key, value in best_parameters.items()},
            "tuningMeanFoldRmseM": best_rmse,
            "outOfFold": scores(y_fit, best_predictions), "folds": best_folds,
        })

    return {
        "schemaVersion": 3, "stage": "XGBoost flood-depth modelling",
        "predictorOrder": names, "modelParameters": MODEL_OPTIONS,
        "predictorPruning": {**pruning, "referencePeriod": 30, "absoluteCorrelationThreshold": 0.95,
                             "rankingSampleCap": pruning_options.perm_cap},
        "hyperparameterSearch": {"trials": SEARCH_TRIALS, "selection": "Lowest mean fold RMSE"},
        "crossValidation": {"folds": fold_count, "blockSizeCells": block_size if cv_mode == "block" else None,
                            "method": "GroupKFold" if cv_mode == "block" else "Shuffled KFold",
                            "metrics": "Pooled tuning-fold predictions against GloFAS-derived targets. Predictor selection uses the full 30-year target and the folds also select hyperparameters."},
        "output": {"depthUnits": "m", "minimumDepth": 0.05, "wetThresholdM": 0.05, "nodata": -9999,
                   "predictionDomain": "Valid model predictors and a finite reference target for that return period.",
                   "analysisDepth": "In-session analysis retains shallow cells and clips negative depths to zero."},
        "packages": {"xgboost": xgboost.__version__, "scikitLearn": sklearn.__version__, "rasterio": rasterio.__version__},
        "results": results,
    }
