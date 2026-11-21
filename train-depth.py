"""Fit a browser baseline to the checked flood-depth inputs."""
from pathlib import Path
import math

import numpy as np
import rasterio
import sklearn
import xgboost
from sklearn.model_selection import GroupKFold
from xgboost import XGBRegressor

from ml import build_design_matrix, _spatial_groups, _write_float32_like


MODEL_OPTIONS = dict(objective="reg:squarederror", tree_method="hist", n_estimators=120,
                     max_depth=4, learning_rate=0.08, max_bin=128, n_jobs=1, random_state=42)
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
    return np.maximum(predicted, 0)


def train_depth_models(folder, predictors, targets, block_size, progress, *, fold_count=5):
    if fold_count not in (4, 5):
        raise ValueError("Select four or five spatial folds.")
    root = Path(folder)
    dem_path = root / "dem.tif"
    dem, grid = read_grid_layer(dem_path)
    dem_mask = np.isfinite(dem)
    features = {}
    for name in predictors:
        values, _ = read_grid_layer(root / f"{name}.tif", grid)
        features[name] = np.where(dem_mask, values, np.nan)
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
        if block_count < fold_count:
            raise ValueError(f"The {period}-year target needs at least {fold_count} occupied spatial blocks.")
        out_of_fold = np.full(y_fit.shape, np.nan, dtype=np.float32)
        fold_scores = []
        for fold, (train, test) in enumerate(GroupKFold(n_splits=fold_count).split(x_fit, y_fit, fit_groups), 1):
            progress(f"{period:,}-year model · spatial fold {fold} of {fold_count}")
            model = XGBRegressor(**MODEL_OPTIONS).fit(x_fit[train], y_fit[train])
            predicted = predict_depth(model, x_fit[test])
            out_of_fold[test] = predicted
            fold_scores.append({
                "fold": fold, "trainCells": len(train), "testCells": len(test),
                "testBlocks": [int(value) for value in np.unique(fit_groups[test])],
                **scores(y_fit[test], predicted),
            })

        progress(f"{period:,}-year model · refitting and exporting depth")
        final = XGBRegressor(**MODEL_OPTIONS).fit(x_fit, y_fit)
        prediction = np.concatenate([predict_depth(final, x[i:i + 32768]) for i in range(0, len(x), 32768)])
        output = np.full(rows * cols, np.nan, dtype=np.float32)
        output[valid] = prediction
        _write_float32_like(dem_path, root / f"xgb_depth_{period}.tif", output.reshape(rows, cols), nodata=-9999)
        final.get_booster().save_model(root / f"xgb_model_{period}.json")
        results.append({
            "period": period, "targetCells": len(y_fit), "occupiedBlocks": block_count,
            "predictionCells": len(prediction), "predictionCellsWithoutReference": int((~eligible).sum()),
            "wetPredictionCells": int((prediction >= WET_DEPTH).sum()),
            "outOfFold": scores(y_fit, out_of_fold), "folds": fold_scores,
        })

    return {
        "schemaVersion": 1, "stage": "XGBoost flood-depth modelling",
        "predictorOrder": names, "modelParameters": MODEL_OPTIONS,
        "crossValidation": {"folds": fold_count, "blockSizeCells": block_size, "method": "GroupKFold",
                            "metrics": "Pooled out-of-fold predictions against GloFAS-derived targets"},
        "output": {"depthUnits": "m", "minimumDepth": 0, "wetThresholdM": 0.05, "nodata": -9999},
        "packages": {"xgboost": xgboost.__version__, "scikitLearn": sklearn.__version__, "rasterio": rasterio.__version__},
        "results": results,
    }
