"""Small deterministic runtime checks. No flood-model accuracy claim."""
import hashlib
import json
import time
from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.io import MemoryFile
from sklearn.model_selection import RandomizedSearchCV
from sklearn.metrics import make_scorer
from xgboost import XGBRegressor, Booster, DMatrix


def run_checks(notify, work_dir=None):
    results = {}
    notify('raster', 'running', 'Checking pixels and spatial metadata')
    t0 = time.perf_counter()
    rows, cols = np.indices((64, 64))
    rng = np.random.default_rng(42)
    features = {
        'elevation': (100 + rows * 0.2 + cols * 0.1).astype('float32'),
        'river_distance': (np.abs(cols - 32) * 30).astype('float32'),
        'rainfall': (80 + rng.random((64, 64)) * 20).astype('float32'),
    }
    # An irregular nodata border exercises footprint masking.
    valid = (rows > 1) & (cols > 2)
    for array in features.values():
        array[~valid] = np.nan
    target = np.maximum(0, 2.8 - np.abs(cols - 32) * 0.12 + rows * 0.008).astype('float32')
    target[~valid] = np.nan
    transform = from_origin(500000, 3700000, 30, 30)
    memory_files = [MemoryFile() for _ in range(3)] if work_dir is None else []
    if memory_files:
        template, roundtrip_path, prediction_path = [mem.name for mem in memory_files]
    else:
        template, roundtrip_path, prediction_path = [str(Path(work_dir) / name) for name in
            ['synthetic-template.tif', 'synthetic-roundtrip.tif', 'synthetic-prediction.tif']]
    with rasterio.open(template, 'w', driver='GTiff', height=64, width=64,
                       count=1, dtype='float32', crs='EPSG:32639',
                       transform=transform, nodata=-9999) as dst:
        dst.write(np.where(valid, target, -9999).astype('float32'), 1)
    loaded, original_grid, nodata = reference.load_single_band_float32(template)
    np.testing.assert_array_equal(np.isnan(loaded), ~valid)
    np.testing.assert_array_equal(loaded[valid], target[valid])
    assert nodata == -9999
    reference._write_float32_like(template, roundtrip_path, loaded, nodata=-9999)
    reopened, grid, _ = reference.load_single_band_float32(roundtrip_path)
    assert reference._grids_equal(original_grid, grid)
    assert grid.height == 64 and grid.width == 64
    np.testing.assert_allclose(grid.transform, (30, 0, 500000, 0, -30, 3700000), rtol=0, atol=0)
    with rasterio.open(roundtrip_path) as src:
        assert src.crs.to_epsg() == 32639 and src.nodata == -9999
    np.testing.assert_array_equal(reopened, loaded)
    results['raster'] = {'shape':[64,64], 'valid_pixels':int(valid.sum()),
        'crs':'EPSG:32639', 'nodata':-9999, 'pixel_roundtrip_max_abs_error':0,
        'seconds':time.perf_counter()-t0}
    notify('raster', 'pass', 'Exact pixels + spatial metadata')

    notify('ml', 'running', 'Spatial folds and small tuning search')
    t0=time.perf_counter()
    nr, nc, X_flat, mask, names = reference.build_design_matrix(features)
    assert (nr, nc) == (64, 64)
    np.testing.assert_array_equal(mask, valid.ravel())
    X = X_flat
    y = target.ravel()[mask]
    groups = reference._spatial_groups(nr, nc, mask, block_size=16)
    # Explicit assignments avoid GroupKFold tie-breaking differences across sklearn versions.
    unique_groups = np.unique(groups)
    cv = []
    for fold in range(3):
        test_mask = np.isin(groups, unique_groups[fold::3])
        cv.append((np.flatnonzero(~test_mask), np.flatnonzero(test_mask)))
    coverage = np.zeros(len(y), dtype='uint8')
    for _, test in cv:
        coverage[test] += 1
    assert (coverage == 1).all()
    split_fingerprint = hashlib.sha256(b''.join(test.astype('<i8').tobytes() for _, test in cv)).hexdigest()
    for train, test in cv:
        assert set(groups[train]).isdisjoint(set(groups[test]))
    model=XGBRegressor(objective='reg:squarederror', tree_method='hist',
                       n_estimators=24, n_jobs=1, random_state=42)
    search=RandomizedSearchCV(model, {'max_depth':[2,3], 'learning_rate':[0.1,0.2]},
        n_iter=2, cv=cv, scoring=make_scorer(reference._rmse, greater_is_better=False),
        n_jobs=1, random_state=42, error_score='raise')
    search.fit(X, y)
    prediction=search.best_estimator_.predict(X)
    assert prediction.shape == y.shape and np.isfinite(prediction).all()
    # Check XGBoost learned this simple synthetic signal; this is not real-data validation.
    train_rmse=reference._rmse(y, prediction)
    baseline_rmse=reference._rmse(y, np.full_like(y, y.mean()))
    assert train_rmse < baseline_rmse, 'Training did not improve on the constant baseline'
    raster=np.full((nr,nc),np.nan,dtype='float32')
    raster.ravel()[mask]=prediction
    reference._write_float32_like(template,prediction_path,raster,nodata=-9999)
    export, export_grid, _=reference.load_single_band_float32(prediction_path)
    assert reference._grids_equal(grid,export_grid)
    np.testing.assert_array_equal(export,raster)
    results['ml']={'samples':len(y),'features':names,'spatial_folds':3,'tuning_candidates':2,
        'jobs':1,'cv_split_sha256':split_fingerprint,'best_parameters':search.best_params_,
        'synthetic_spatial_cv_rmse':float(-search.best_score_),
        'synthetic_training_rmse':train_rmse,'constant_training_baseline_rmse':baseline_rmse,
        'input_array_bytes':int(X.nbytes+y.nbytes),
        'seconds':time.perf_counter()-t0}
    notify('ml','pass','Training + spatial CV + prediction')

    notify('persistence','running','Saving and restoring model')
    t0=time.perf_counter()
    model_path = str(Path(work_dir or '/') / 'synthetic-xgb.json')
    search.best_estimator_.get_booster().save_model(model_path)
    restored=Booster(params={'nthread':1})
    restored.load_model(model_path)
    p2=restored.predict(DMatrix(X))
    np.testing.assert_allclose(prediction,p2,rtol=0,atol=1e-6)
    results['persistence']={'format':'XGBoost Booster JSON (not sklearn wrapper)',
        'prediction_max_abs_error':float(np.max(np.abs(prediction-p2))),
        'tolerance':1e-6,'prediction_sha256':hashlib.sha256(prediction.tobytes()).hexdigest(),
        'seconds':time.perf_counter()-t0}
    notify('persistence','pass','Reloaded predictions match')
    if memory_files:
        memory_files[2].seek(0)
        with open('/synthetic-prediction.tif','wb') as output:
            output.write(memory_files[2].read())
        for mem in memory_files:
            mem.close()
    return results
