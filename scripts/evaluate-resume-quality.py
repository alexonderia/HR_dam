"""Compare held-out recruiter labels with predictions; never manufacture labels."""

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path


def load_jsonl(path):
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows or len({row["case_id"] for row in rows}) != len(rows):
        raise ValueError("Dataset must be nonempty with unique case_id values")
    return {row["case_id"]: row for row in rows}


def indexed(items, field):
    identifiers = [item["id"] for item in items]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError(f"Duplicate {field} identifiers")
    return dict(zip(identifiers, items))


def percentile(values, fraction):
    values = sorted(values)
    return values[max(0, math.ceil(len(values)*fraction)-1)] if values else None


def evaluate(labels, predictions):
    if set(labels) != set(predictions):
        raise ValueError("Labels and predictions must contain exactly the same held-out cases")
    counts = {name: {"tp": 0, "fp": 0, "fn": 0} for name in ("skills", "stops")}
    status_correct = status_total = evidence_total = evidence_invalid = determined = 0
    score_errors = []
    reviewers = set()
    confusion = defaultdict(Counter)
    invariance=defaultdict(list)
    slices = defaultdict(lambda: {"cases":0,"criteria":0,"correct":0,"determined":0,"determined_correct":0})
    determined = determined_correct = sufficient = reviewed_citations = 0
    latencies = []
    timeouts = errors = evaluated_cases = 0
    for case_id, label in labels.items():
        if label.get("independent") is not True or not label.get("reviewer_id"):
            raise ValueError("Every label must identify an independent recruiter reviewer")
        reviewers.add(label["reviewer_id"])
        prediction = predictions[case_id]
        expected, actual = label["rating"], prediction.get("rating")
        duration = prediction.get("latency_ms")
        if duration is not None:
            if isinstance(duration,bool) or not isinstance(duration,(int,float)) or not math.isfinite(duration) or duration<0:
                raise ValueError("latency_ms must be finite and nonnegative")
            latencies.append(duration)
        timeouts += prediction.get("error_code") == "timeout"
        errors += bool(prediction.get("error_code"))
        buckets = [slices["all"], slices["profession:"+label.get("profession","unspecified")], slices["format:"+label.get("format","unspecified")]]
        for bucket in buckets: bucket["cases"] += 1
        if actual is None:
            if not prediction.get("error_code"):raise ValueError("Missing rating without an error code")
            continue
        evaluated_cases+=1
        source = label["resume_text"]
        for name, field in (("skills", "matched_keywords"), ("stops", "triggered_stop_factors")):
            wanted = {word.casefold().strip() for word in expected[field]}
            found = {word.casefold().strip() for word in actual.get(field, [])}
            counts[name]["tp"] += len(wanted & found)
            counts[name]["fp"] += len(found - wanted)
            counts[name]["fn"] += len(wanted - found)
        predicted_criteria = indexed(actual["details"]["criteria"], "criterion")
        expected_criteria = indexed(expected["criteria"], "reference criterion")
        if set(predicted_criteria)!=set(expected_criteria):
            raise ValueError("Missing or foreign criterion IDs")
        predicted_stops = indexed(actual["details"]["stop_factors"], "stop")
        if set(predicted_stops)!=set(indexed(expected.get("stop_factors",[]),"reference stop")):
            raise ValueError("Missing or foreign stop IDs")
        for criterion in expected["criteria"]:
            status_total += 1
            found = predicted_criteria[criterion["id"]]["status"]
            if found not in {"met","partial","not_met","unknown"}:raise ValueError("Invalid criterion status")
            correct = found == criterion["status"]
            status_correct += correct
            confusion[criterion["status"]][found] += 1
            determined += found != "unknown"
            determined_correct += correct and found != "unknown"
            for bucket in buckets:
                bucket["criteria"] += 1
                bucket["correct"] += correct
                bucket["determined"] += found != "unknown"
                bucket["determined_correct"] += correct and found != "unknown"
            if "sufficient_citations" in criterion:
                reviewed_citations += 1
                sufficient += any(q["quote"] in criterion["sufficient_citations"] for q in predicted_criteria[criterion["id"]]["evidence"])
        group=label.get("invariance_group")
        if group:
            invariance[group].append(tuple(sorted((c.get("invariant_key",c["id"]),predicted_criteria[c["id"]]["status"]) for c in expected["criteria"])))
        for stop in expected.get("stop_factors",[]):
            confusion["stop:"+stop["status"]][predicted_stops[stop["id"]]["status"]]+=1
        for item in actual["details"]["criteria"] + actual["details"]["stop_factors"]:
            for evidence in item["evidence"]:
                evidence_total += 1
                start, end = evidence["start"], evidence["end"]
                evidence_invalid += not (0 <= start < end <= len(source) and source[start:end] == evidence["quote"])
        if expected.get("score") is not None:
            score_errors.append(abs(expected["score"] - actual["score"]))
    for tally in counts.values():
        tally["precision"] = tally["tp"] / (tally["tp"] + tally["fp"]) if tally["tp"] + tally["fp"] else None
        tally["recall"] = tally["tp"] / (tally["tp"] + tally["fn"]) if tally["tp"] + tally["fn"] else None
    return {"status": "evaluated", "cases": len(labels),"evaluated_cases":evaluated_cases, "independent_reviewers": len(reviewers), **counts,
            "criterion_status_accuracy": status_correct / status_total if status_total else None,
            "criterion_labels": status_total, "citations": evidence_total, "invalid_citations": evidence_invalid,
            "score_mae": sum(score_errors) / len(score_errors) if score_errors else None,
            "cases_with_reference_score": len(score_errors),
            "confusion_matrix": dict(confusion), "determined_fraction": determined/status_total if status_total else None,
            "determined_accuracy": determined_correct/determined if determined else None,
            "sufficient_citation_fraction": sufficient/reviewed_citations if reviewed_citations else None,
            "citation_sufficiency_labels": reviewed_citations, "slices":dict(slices),
            "latency_ms":{"p50":percentile(latencies,.5),"p95":percentile(latencies,.95),"observations":len(latencies)},
            "timeouts":timeouts,"errors":errors,
            "invariance":{"groups":sum(len(rows)>=2 for rows in invariance.values()),"groups_with_status_changes":sum(len(rows)>=2 and len(set(rows))>1 for rows in invariance.values()),"cases":sum(map(len,invariance.values()))}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", required=True, help="JSONL independently annotated before inspecting model predictions")
    parser.add_argument("--predictions", required=True, help="JSONL predictions for the same held-out case IDs")
    parser.add_argument("--output", help="Optional JSON metrics file")
    args = parser.parse_args()
    report = evaluate(load_jsonl(args.labels), load_jsonl(args.predictions))
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(payload + "\n", encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
