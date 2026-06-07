# Participant provisioning

Creates **real pilot participant accounts** from a roster — **additively**. It never deletes or
overwrites anything, so the existing demo/soak **test history stays intact** for your manager to
review in the dashboard.

> Run this only **after** IRB approval, the `ANTHROPIC_API_KEY` rotation, and the superadmin
> password change (see `docs/GO-LIVE-CHECKLIST.md`).

## Steps
```bash
# 1. Make your roster from the template and fill in real participants
cp scripts/provision/roster.example.json scripts/provision/roster.json
#    edit roster.json — email + full_name_th + full_name_en are required; specialty/license optional

# 2. Dry-run (default — NO accounts created, just validates the roster)
node scripts/provision/provision-participants.js

# 3. Create the accounts (real superadmin path: slot limits + P-NNN pseudonyms apply)
PROVISION_SUPERADMIN_PW='<superadmin password>' node scripts/provision/provision-participants.js --confirm
```

Each participant gets a **unique strong password**, written to a gitignored
`scripts/provision/credentials-<timestamp>.txt` — distribute it through a secure channel.

## Notes
- **Non-destructive.** Clearing the demo/soak cohort is a separate, deliberate step you run when
  ready: `node db/reset-demo.js`. This script does **not** call it.
- Idempotent-ish: an email that already exists is skipped (not duplicated).
- Stops if the physician role-slot pool is full (raise it in the Superadmin → role slots page).
- `roster.json` and `credentials-*.txt` are gitignored — never commit real rosters or passwords.
