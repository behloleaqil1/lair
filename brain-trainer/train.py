"""Fit the brain trainer's classifier: gradient-boosted trees over numeric features.

    python train.py <input.json> <model.json> <fit.json>

input.json  {"rows": [{"features": {name: number}, "label": str}], "params": {...}}
model.json  the trees, in the format src/server/brain-trainer/model.ts evaluates
fit.json    counts and the library version

No network and no state: the same input gives the same model.
"""
import json
import math
import sys

import numpy as np
import sklearn
from sklearn.ensemble import GradientBoostingClassifier

MAX_ROWS = 200_000
MAX_FEATURES = 20_000


class InputError(Exception):
    pass


def read_input(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    rows = raw.get("rows") if isinstance(raw, dict) else None
    if not isinstance(rows, list) or not rows or len(rows) > MAX_ROWS:
        raise InputError("rows must be a non-empty list")
    params = raw.get("params") or {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("label"), str) or not isinstance(row.get("features"), dict):
            raise InputError("each row needs a label and features")
        for name, value in row["features"].items():
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                raise InputError("feature values must be finite numbers")
    return rows, params


def matrix(rows):
    names = sorted({name for row in rows for name in row["features"]})
    if len(names) > MAX_FEATURES:
        raise InputError("too many features")
    index = {name: i for i, name in enumerate(names)}
    x = np.zeros((len(rows), max(len(names), 1)), dtype=np.float64)
    for r, row in enumerate(rows):
        for name, value in row["features"].items():
            x[r, index[name]] = value
    return x, names


def export_tree(estimator):
    t = estimator.tree_
    feature = [int(f) if f >= 0 else 0 for f in t.feature]
    return {
        "left": [int(v) for v in t.children_left],
        "right": [int(v) for v in t.children_right],
        "feature": feature,
        "threshold": [float(v) if math.isfinite(v) else 0.0 for v in t.threshold],
        "value": [float(v) for v in t.value[:, 0, 0]],
    }


def fit(rows, params):
    x, names = matrix(rows)
    labels = [row["label"] for row in rows]
    classes = sorted(set(labels))
    seed = int(params.get("seed", 0))
    if len(classes) == 1:
        # One answer ever given: nothing to learn, and the model says so
        model = {"classes": classes, "init": [0.0], "stages": [], "learningRate": 0.1}
        return model, names, seed
    clf = GradientBoostingClassifier(
        n_estimators=int(params.get("nEstimators", 100)),
        max_depth=int(params.get("maxDepth", 3)),
        learning_rate=float(params.get("learningRate", 0.1)),
        random_state=seed,
    )
    clf.fit(x, labels)
    assert list(clf.classes_) == classes
    init = np.asarray(clf._raw_predict_init(x[:1]))[0]
    stages = [[export_tree(est) for est in stage] for stage in clf.estimators_]
    model = {
        "classes": classes,
        "init": [float(v) for v in init],
        "stages": stages,
        "learningRate": float(clf.learning_rate),
    }
    return model, names, seed


def build(rows, params):
    model, names, seed = fit(rows, params)
    model.update({"format": "lair-gbt-1", "featureNames": names, "trainedOn": len(rows)})
    fit_info = {
        "rows": len(rows),
        "classes": len(model["classes"]),
        "features": len(names),
        "sklearn": sklearn.__version__,
        "seed": seed,
    }
    return model, fit_info


def main(argv):
    if len(argv) != 4:
        print("usage: train.py <input.json> <model.json> <fit.json>", file=sys.stderr)
        return 2
    try:
        rows, params = read_input(argv[1])
        model, fit_info = build(rows, params)
    except (InputError, ValueError, OSError) as e:
        print(f"train.py: {e}", file=sys.stderr)
        return 2
    with open(argv[2], "w", encoding="utf-8") as f:
        json.dump(model, f)
    with open(argv[3], "w", encoding="utf-8") as f:
        json.dump(fit_info, f)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
