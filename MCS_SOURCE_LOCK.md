# Main Character Studios by Tiffani

Clean source of truth for the Main Character Studios by Tiffani production application.

- Main production app: Vercel project `main-characters-studios-by-tiffani`
- Customer domain: `main-character-studios.vercel.app`
- Funded AI Gateway credential belongs in Vercel as `AI_GATEWAY_API_KEY`; never commit secrets to GitHub.
- Pipeline: Stage -> AI Gateway -> RunPod -> Runway + ElevenLabs -> Stripe -> My Orders -> customer movie.
