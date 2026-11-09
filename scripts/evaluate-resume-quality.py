"""Compare held-out recruiter labels with predictions; never manufacture labels."""

import argparse
import json
from pathlib import Path


def load_jsonl(path):
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows or len({row["case_id"] for row in rows}) != len(rows):
        raise ValueError("Dataset must be nonempty with unique case_id values")
    return {row["case_id"]: row for row in rows}


def evaluate(labels, predictions):
    if set(labels) != set(predictions):
        raise ValueError("Labels and predictions must contain exactly the same held-out cases")
    counts = {name: {"tp": 0, "fp": 0, "fn": 0} for name in ("skills", "stops")}
    status_correct = status_total = evidence_total = evidence_invalid = 0
    score_errors = []
    reviewers = set()
    for case_id, label in labels.items():
        if label.get("independent") is not True or not label.get("reviewer_id"):
            raise ValueError("Every label must identify an independent recruiter reviewer")
        reviewers.add(label["reviewer_id"])
        expected, actual = label["rating"], predictions[case_id]["rating"]
        source = label["resume_text"]
        for name, field in (("skills", "matched_keywords"), ("stops", "triggered_stop_factors")):
            wanted = {word.casefold().strip() for word in expected[field]}
            found = {word.casefold().strip() for word in actual.get(field, [])}
            counts[name]["tp"] += len(wanted & found)
            counts[name]["fp"] += len(found - wanted)
            counts[name]["fn"] += len(wanted - found)
        predicted_criteria = {c["id"]: c for c in actual["details"]["criteria"]}
        for criterion in expected["criteria"]:
            status_total += 1
            status_correct += predicted_criteria.get(criterion["id"], {}).get("status") == criterion["status"]
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
    return {"status": "evaluated", "cases": len(labels), "independent_reviewers": len(reviewers), **counts,
            "criterion_status_accuracy": status_correct / status_total if status_total else None,
            "criterion_labels": status_total, "citations": evidence_total, "invalid_citations": evidence_invalid,
            "score_mae": sum(score_errors) / len(score_errors) if score_errors else None,
            "cases_with_reference_score": len(score_errors)}


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
