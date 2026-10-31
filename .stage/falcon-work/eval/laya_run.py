"""Ask Laya about every reply and every segment of the evaluation set.

    python laya_run.py eval-set.json predictions.json [english|multilingual ...]

Writes, per checkpoint, the probability for each wording of the question, so score.mjs can
compare wordings, checkpoints and thresholds without rerunning the model.
"""
import json, sys, time
from laya import Router

SEGMENT_QUESTIONS_V2 = {
    "request": {"type": "choice", "instructions": "Is this sentence a question or request to the reader, or a statement?", "criteria": {
        "request": "a question or request to the reader",
        "statement": "a statement or report"}},
}
SEGMENT_QUESTIONS = {
    "ask_a": {"type": "noul", "instructions": "Does this sentence ask the reader to give information, make a decision, approve something, or do something?"},
    "ask_b": {"type": "noul", "instructions": "Is the writer waiting on the reader for an answer, a choice, an approval or an action before the writer can continue?"},
    "kind": {"type": "choice", "instructions": "What is this sentence, from the reader's point of view?", "criteria": {
        "need": "a request the writer needs the reader to answer, decide, approve or do",
        "offer": "an optional offer of more help, which the reader can ignore",
        "chat": "small talk or a conversational question that needs no answer for the work to continue",
        "none": "information, a report or a statement"}},
}
REPLY_QUESTIONS = {
    "reply_ask": {"type": "noul", "instructions": "Does this message ask the reader for information, a decision, an approval or an action that the writer needs?"},
}

def main():
    src, out, *models = sys.argv[1:]
    v2 = "--v2" in models
    models = [m for m in models if not m.startswith("--")] or ["english", "multilingual"]
    items = json.load(open(src))
    router = Router()
    results = {}
    for model in models:
        t0 = time.time()
        reqs, keys = [], []
        for it in items:
            if not v2:
                reqs.append({"state": it["reply"][-3000:], "questions": REPLY_QUESTIONS, "model": model})
                keys.append((it["id"], None))
            for n, s in enumerate(it["segments"]):
                state = (f"Previous line: {s['context']}\n" if s["context"] else "") + f"Sentence: {s['text']}"
                reqs.append({"state": state, "questions": SEGMENT_QUESTIONS_V2 if v2 else SEGMENT_QUESTIONS, "model": model})
                keys.append((it["id"], n))
        answers = router.predict_batch(reqs, batch_size=16, sort_by_length=True)
        per = {}
        for (iid, n), a in zip(keys, answers):
            ans = a["answers"]
            row = per.setdefault(iid, {"reply": None, "segments": {}})
            if n is None:
                row["reply"] = ans["reply_ask"]["noul"]
            elif v2:
                row["segments"][n] = {"request": ans["request"]["probabilities"]["request"]}
            else:
                row["segments"][n] = {"ask_a": ans["ask_a"]["noul"], "ask_b": ans["ask_b"]["noul"],
                                      "kind": ans["kind"]["choice"], "kind_p": ans["kind"]["probabilities"]}
        secs = time.time() - t0
        results[model] = {"seconds": secs, "requests": len(reqs), "items": per}
        print(f"{model}: {len(reqs)} requests in {secs:.0f}s ({1000*secs/len(reqs):.0f} ms each)", flush=True)
        json.dump(results, open(out, "w"))  # after each checkpoint, so a long run is never all-or-nothing

if __name__ == "__main__":
    main()
