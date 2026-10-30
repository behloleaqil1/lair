"""Tests for train.py: the exported trees give the same probabilities as the fitted model."""
import json
import math
import os
import subprocess
import sys

import numpy as np
import pytest

import train

HERE = os.path.dirname(os.path.abspath(__file__))


def walk(tree, x):
    node = 0
    while tree["left"][node] != -1:
        node = tree["left"][node] if x[tree["feature"][node]] <= tree["threshold"][node] else tree["right"][node]
    return tree["value"][node]


def probabilities(model, features):
    """The evaluation src/server/brain-trainer/model.ts does, in Python."""
    x = [np.float32(features.get(n, 0.0)) for n in model["featureNames"]]
    classes = model["classes"]
    lr = model["learningRate"]
    if len(classes) == 1:
        return {classes[0]: 1.0}
    if len(classes) == 2:
        raw = model["init"][0] + sum(lr * walk(stage[0], x) for stage in model["stages"])
        p1 = 1 / (1 + math.exp(-raw))
        return {classes[0]: 1 - p1, classes[1]: p1}
    raw = [model["init"][k] + sum(lr * walk(stage[k], x) for stage in model["stages"]) for k in range(len(classes))]
    m = max(raw)
    e = [math.exp(r - m) for r in raw]
    return {c: v / sum(e) for c, v in zip(classes, e)}


def rows(n=60, labels=("wait", "restart", "release")):
    out = []
    for i in range(n):
        attempts = i % 6
        label = labels[0] if attempts < 2 else labels[1] if attempts < 4 else labels[-1]
        out.append({"features": {"ev.attempts": float(attempts), "module=agents": 1.0, "hour": float(i % 24)}, "label": label})
    return out


@pytest.mark.parametrize("labels", [("wait", "restart", "release"), ("wait", "restart", "restart")])
def test_exported_trees_match_the_fitted_model(labels):
    data = rows(labels=labels)
    model, _ = train.build(data, {"nEstimators": 20, "maxDepth": 2, "seed": 1})
    x, names = train.matrix(data)
    clf = train.GradientBoostingClassifier(n_estimators=20, max_depth=2, learning_rate=0.1, random_state=1)
    clf.fit(x, [r["label"] for r in data])
    assert model["featureNames"] == names
    for i, row in enumerate(data):
        expected = dict(zip(clf.classes_, clf.predict_proba(x[i : i + 1])[0]))
        got = probabilities(model, row["features"])
        for c in expected:
            assert got[c] == pytest.approx(expected[c], abs=1e-6)


def test_the_same_input_gives_the_same_model():
    a, _ = train.build(rows(), {"nEstimators": 10, "seed": 3})
    b, _ = train.build(rows(), {"nEstimators": 10, "seed": 3})
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def test_one_class_gives_a_model_that_says_so():
    model, info = train.build([{"features": {"a": 1.0}, "label": "wait"}] * 5, {})
    assert model["classes"] == ["wait"] and model["stages"] == []
    assert probabilities(model, {"a": 1.0}) == {"wait": 1.0}
    assert info["classes"] == 1


def test_child_indexes_are_above_their_parent_so_the_evaluation_ends():
    model, _ = train.build(rows(), {"nEstimators": 5})
    for stage in model["stages"]:
        for tree in stage:
            for i, (l, r) in enumerate(zip(tree["left"], tree["right"])):
                assert (l == -1 and r == -1) or (l > i and r > i)


def run_cli(tmp_path, payload):
    src = tmp_path / "input.json"
    src.write_text(json.dumps(payload))
    return subprocess.run(
        [sys.executable, os.path.join(HERE, "train.py"), str(src), str(tmp_path / "model.json"), str(tmp_path / "fit.json")],
        capture_output=True,
        text=True,
    )


def test_the_command_writes_the_model_and_the_fit(tmp_path):
    result = run_cli(tmp_path, {"rows": rows(), "params": {"nEstimators": 5}})
    assert result.returncode == 0, result.stderr
    assert json.loads((tmp_path / "model.json").read_text())["format"] == "lair-gbt-1"
    assert json.loads((tmp_path / "fit.json").read_text())["rows"] == 60


@pytest.mark.parametrize(
    "payload",
    [
        {"rows": []},
        {"rows": [{"features": {"a": "x"}, "label": "wait"}]},
        {"rows": [{"features": {"a": float("inf")}, "label": "wait"}]},
        {"rows": [{"features": {"a": 1}}]},
    ],
)
def test_bad_input_is_refused_without_writing_a_model(tmp_path, payload):
    result = run_cli(tmp_path, payload)
    assert result.returncode == 2
    assert not (tmp_path / "model.json").exists()
