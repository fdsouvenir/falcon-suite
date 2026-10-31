"""Run a Falcon Work gate over the evaluation set with Laya.

    python gate_run.py eval-set.json gates.json out.json [model:max_len:head_max_len ...]

Each turn becomes one request with the state the gate would see in Work. Results are saved after
each model/variant so a long run is never all-or-nothing.
"""
import json, sys, time
from laya import Router

# Turns where the agent had already recorded its questions in Work (raised_in_work).
RAISED = {"r027": ["What city, state/region, and country is the house in?",
                   "Does spring 2027 mean listing or completed closing? Any firm move-out deadline?"]}

def state_for(it, reply_chars):
    return {
        "request": (it.get("user") or "")[:300],
        "raised_in_work": RAISED.get(it["id"], []),
        "task_in_progress": None,
        "reply": it["reply"][-reply_chars:],
    }

def main():
    src, gates_file, out, *runs = sys.argv[1:]
    items = json.load(open(src))
    gate = json.load(open(gates_file))["left_waiting"]
    variants = {"full": gate["question"], "compact": gate["compact"]}
    router = Router()
    results = {}
    for spec in runs or ["multilingual:2048:384"]:
        model, max_len, head = spec.split(":")
        reply_chars = 2400 if int(max_len) >= 2048 else 1200
        for vname, q in variants.items():
            t0 = time.time()
            reqs = [{"state": state_for(it, reply_chars), "questions": {"gate": q}, "model": model,
                     "max_len": int(max_len), "head_max_len": int(head)} for it in items]
            answers = router.predict_batch(reqs, batch_size=8)
            key = f"{model}/{vname}/{max_len}/{head}"
            results[key] = {"seconds": time.time() - t0, "items": {
                it["id"]: {"choice": a["answers"]["gate"]["choice"], "p": a["answers"]["gate"]["probabilities"]}
                for it, a in zip(items, answers)}}
            print(f"{key}: {len(reqs)} turns in {time.time()-t0:.0f}s", flush=True)
            json.dump(results, open(out, "w"))

if __name__ == "__main__":
    main()
