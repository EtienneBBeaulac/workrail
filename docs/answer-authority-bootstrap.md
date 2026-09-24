# Explicit authority for the answers MCP profile

The answers profile exposes `open_work`, `answer_work`, `inspect_work`, and
`recover_work`. Transport startup must select its durable authority explicitly.
This configuration path works through the shared stdio and HTTP composition root.
It does not enable supervised daemon dispatch or make unsupported workflow features
available.

Create a UTF-8 JSON file containing absolute paths to the intended authority:

```json
{
  "formatVersion": 1,
  "authority": {
    "storage": {
      "journalRootDir": "/absolute/workrail/sessions",
      "hostIndexRootDir": "/absolute/workrail/index"
    },
    "keyringPath": "/absolute/workrail/keys/keyring.json",
    "workflowStoragePath": "/absolute/workrail/workflows"
  }
}
```

Select `WORKRAIL_AGENT_PROFILE=answers` and set
`WORKRAIL_ANSWER_AUTHORITY_FILE` to that file's absolute path when starting the
built MCP executable. Keep the same authority paths across process restarts.
The file contains paths, not copied tokens or keys. Protect it as operator
configuration: changing these paths selects a different authority.

The reader accepts only regular files up to 64 KiB, version 1, and the exact
fields shown above. Missing, malformed, unreadable, relative, or conflicting
configuration refuses startup before composition. There is no fallback to the
legacy profile. The authority-file variable is invalid with a non-answers profile.
Programmatic callers can still supply `composeServer({ answerAuthority })`, but
must not also supply the authority-file environment variable.

The real stdio integration test builds the executable, opens a two-question notes
workflow, records the first answer, closes the process, and resumes the same reply
in a fresh process before finishing. This proves process restart persistence for
that supported workflow; it does not prove provider settlement, daemon recovery,
or an installed runtime rollout.
