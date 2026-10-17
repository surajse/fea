# Toy CLI — acceptance demo

`adder.js` is the reference "original" for the v0.1 demo loop:

```bash
fea ingest ./examples/toy-cli/adder.js --kind cli --i-have-rights
# → { "id": "tgt_..." }

fea capture --target tgt_... --plans '[
  {"name":"add","argv":["2","3"]},
  {"name":"neg","argv":["-1","1"]},
  {"name":"help","argv":["--help"]},
  {"name":"bad","argv":["x"]}
]'
# → { "vectorSetId": "vs_..." }

fea spec --vectorset vs_...
# → validated BehaviorSpec JSON

fea plan --spec spec_...
# → plan + one-time approval token (human approves here)

fea synth-context --spec spec_... --token appr_...
# → firewalled synthesis context (behavior only)

# ...agent (or you) writes rebuild/adder2.js from the context only...

fea verify --target tgt_... --rebuild ./rebuild/adder2.js --vectorset vs_...
# → parity report with score

fea pack --spec spec_... --report rep_...
# → reproducible evidence pack
```

Expected result on the toy: **parity 100**.
