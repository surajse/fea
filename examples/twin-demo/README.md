# Twin demo: wc-twin@1.0.0

The Twin Era in one directory. `original/wc.js` is a small word-count utility
— treat it as closed source. `twin/wc-twin.js` was written clean-room from
observed behavior only (different code, same behavior — even `\v`, `\f`, and
emoji edge cases match).

Run the whole story:

```sh
S=/tmp/twin-demo/.fea
T=$(fea --store $S ingest ./original/wc.js --kind cli --i-have-rights | jq -r .id)
V=$(fea --store $S capture --target $T \
  --plans '[{"argv":[],"stdin":"hello world\n"},{"argv":[],"stdin":""},{"argv":[],"stdin":"a\nb\nc\n"}]' \
  --yes | jq -r .vectorSetId)
SP=$(fea --store $S spec --vectorset $V | jq -r .id)
R=$(fea --store $S verify --target $T --rebuild ./twin/wc-twin.js --vectorset $V --yes \
  | jq -r '.report.id')
# expect parity 100
P=$(fea --store $S pack --spec $SP --report $R | jq -r .packDir)

# mint the twin
fea --store $S twin publish --pack $P --name wc-twin \
  --description "word-count utility twin, parity 100" --yes

# someone else finds it and fetches it — verified on arrival
fea --store $S twin search word
fea --store $S twin get wc-twin --out-dir /tmp/wc-twin-pack
fea --store $S pack-verify /tmp/wc-twin-pack
```

That last line is the whole thesis: **trust, but verify.**
