# The grill play picks from a vetted option bank and never writes option text

In a grill play the AI chooses, per question, one reviewed question variant (adding at most a short bridge from the visitor's last answer) and three option ids from the option bank for the visitor's path, exactly one per tier. The kiosk shows the options' reviewed text word for word, and the server rejects any other pick and falls back to a default trio. The next step's bank depends on the full path of tiers chosen so far (1 + 3 + 9 banks per case); a typed answer is sorted by the AI into a tier, unclear or unsafe going down the weaker branch, and only that tier letter is stored. We chose this over AI-generated options because, with no physician read (ADR 0005), only a fixed, reviewed bank keeps every option a visitor can see reviewed, and one-per-tier keeps difficulty matched across visitors.

## Considered options

- **AI writes the options, a screen rejects unsafe ones**: more variety, but the screen catches only known kinds of unsafe option, and difficulty drifts.
- **AI rewords the chosen options**: reads more naturally, but reworded text was never reviewed and can change meaning (#233's "confirm" vs "support").
