# Evolve agent example

`fea evolve` drives an external agent program in a loop until parity converges.
The agent can be anything — an LLM CLI wrapper, a synthesis script, a build
system hook — as long as it speaks the protocol:

- **stdin**: `EvolveAgentRequest` JSON —
  `{ attempt, maxAttempts, targetScore, lastScore, synthesisContext, failingVectors }`
- **stdout**: exactly `{"rebuildPath": "/abs/path/to/rebuild"}` (JSON, nothing else)
- **stderr**: free-form logs

The agent sees **only** the firewalled synthesis context (observed behavior:
surfaces, I/O examples, invariants) plus the previous attempt's failing
vectors. It never sees the original binary's path — FEA checks this and fails
closed if the path ever leaks into the request.

`mock-agent.js` is a scripted demo: attempt 1 writes a stub (scores low),
attempt 2 writes the real thing (converges). Run it:

```sh
fea evolve --spec spec_x --vectorset vs_y \
  --agent-cmd node --agent-arg ./examples/evolve-agent/mock-agent.js \
  --max-attempts 3 --yes
```

To wire a real agent (e.g. an LLM), write a small wrapper that:

1. reads the request JSON from stdin,
2. renders `synthesisContext` + `failingVectors` into a prompt,
3. calls the model, writes the returned code to a file,
4. prints `{"rebuildPath": "<file>"}` on stdout.

Keep the clean-room contract: the prompt must contain behavior only. Never
hand the agent the original binary, its path, or REA reader output about its
internals.
