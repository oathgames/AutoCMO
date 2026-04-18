---
name: merlin-analytics
description: Use when the user asks about performance, how their ads/store/business are doing, ROAS, CPA, ROI, MER, spend, aggregate revenue, dashboard, weekly numbers, wisdom insights, landing page audits, or conversion optimization. Covers the cross-platform dashboard (unified MER/ROAS across every connected platform), the wisdom engine (anonymized collective insights), the marketing calendar (launch cadence + seasonal gaps), and the 8-dimension landing page Conversion Rubric. Pulls exact numbers from `mcp__merlin__dashboard` — never estimates or derives metrics.
owner: ryan
---

# Analytics & Performance

## Dashboard (`mcp__merlin__dashboard`)

| Action | Key params | Returns |
|---|---|---|
| `dashboard` | `brand`, `batchCount` (days) | Unified cross-platform MER/ROAS, spend, revenue, top/bottom ads, recommendations |
| `wisdom` | `brand` | Collective anonymized insights (hook CTR, format win-rate, timing patterns by vertical) |
| `calendar` | `brand` | Launch history, average cadence, seasonal signals, upcoming gaps |

**Topline revenue routing** — `dashboard` internally resolves `RevenueSource` across every connector (see `merlin-ecom` for the preference rules). Never compute revenue by summing Shopify + Stripe yourself — the abstraction handles double-count protection.

**Goal pacing** — if `assets/brands/<brand>/goal.md` exists, `dashboard` attaches a `goal` block with `status` (ahead / on-track / behind / at-risk), `targetRevenue`, `actualRevenue`, `requiredPerDay`, and a one-line `message` comparing expected vs. actual against the monthly/weekly/quarterly window. Surface this prominently in digests ("Pacing: behind — $20k of $50k target at 50% of month elapsed, need $1,667/day to finish"). When no goal is set, the block is omitted. Goals are captured at onboarding (see `merlin-setup`) or via `{"action": "goal-set", ...}`.

## Performance table rules

Render only fields that exist in the JSON output. For `meta-insights`, the `campaign_summary` block has **exactly**:

`campaign_name`, `category`, `spend`, `revenue`, `roas`, `purchases`, `impressions`, `clicks`, `ctr`, `cost_per_purchase`, `ad_count`

Never invent columns like Status, Reach, Results, or Budget. Use pre-computed summaries verbatim — don't re-sum the `ads` array. One label per metric (`Cost/Purchase` OR `CPP`, not both). **Max 6 columns.** Campaign names are authoritative — never flatten "Merlin - Testing" to "merlin."

## Data integrity rules

- **Every number comes from an action.** Never estimate, calculate, or fabricate metrics.
- **Quote exact values from action output.** No rounding, no paraphrasing.
- **No mental math on money.** Use `dashboard` for aggregates. Never sum spend, derive ROAS trends, or calculate budget remaining yourself.
- **If a number isn't in an action's output, say "let me check" and run the action.**

## Wisdom

`mcp__merlin__dashboard({action: "wisdom"})` reads `.merlin-wisdom.json` — anonymized collective data aggregated server-side from all Merlin users.

**Cite wisdom when recommending.** When suggesting a hook style, format, or timing, quote the stat with sample size: *"UGC averages 2.8% CTR (wisdom, N=45)"*. Never invent collective stats.

**Prefer wisdom-validated choices** for the user's vertical:
- Hook styles with higher avg CTR.
- Formats with better win rate.
- Timing patterns that work across similar brands.

## Calendar

`mcp__merlin__dashboard({action: "calendar"})` returns launch predictions and seasonal gaps. Use for:
- **Content planning** — if a product launch or seasonal event is within 7 days, prioritize that product for creative generation (override normal rotation).
- **Quiet stretches** — no launches for 14+ days → generate evergreen content for best-performing product.

## Briefing

Every optimization run writes `assets/brands/<brand>/briefing.json` AND root `.merlin-briefing.json`:

```json
{
  "date": "YYYY-MM-DD",
  "ads": {"killed": N, "scaled": N, "created": N, "active": N},
  "content": {"blogs": N, "images": N},
  "revenue": {"total": "$X", "trend": "+Y%"},
  "bestHookStyle": "ugc",
  "bestFormat": "9:16",
  "avgROAS": X.X,
  "recommendation": "One-sentence strategic suggestion based on today's data"
}
```

Derive `bestHookStyle` / `bestFormat` from memory.md `## What Works` (most frequent recent winner). Derive `avgROAS` from today's dashboard output.

## Conversion Rubric (Landing Pages)

When running `landing-audit` or auditing any conversion page, score 8 dimensions 0–100, weighted:

| Dimension | Weight | Check |
|---|---|---|
| Headline clarity | 15% | Stranger describes what it does in 5 seconds |
| CTA visibility | 15% | Above-fold, high contrast, action verb, one primary CTA |
| Social proof | 15% | Real names/logos/numbers — not "trusted by thousands" |
| Urgency | 10% | Specific scarcity ("28 left," "ends Friday") — not "limited time" |
| Trust signals | 10% | Guarantees, security badges, refund policy, real contact info |
| Form friction | 15% | Field count ≤ what's strictly required to fulfill |
| Mobile responsive | 10% | Tap targets ≥44px, no horizontal scroll, readable without zoom |
| Page speed | 10% | LCP <2.5s, CLS <0.1, hero image <200KB |

**Overall grade:** A (90+) / B (80–89) / C (70–79) / D (60–69) / F (<60). Grade below B → fix before adding traffic. **Never recommend scaling ad spend into a C/D/F page.**

**Automatic enforcement.** The grade is cached to `.merlin-landing-audits.json` by `landing-audit`. `meta-budget` and `meta-duplicate` (scale-up paths) call `enforceLandingGrade` before changing spend — scores below 80 are refused unless the caller passes `force=true`. Unaudited URLs pass silently, so this is not a surprise block on new pages. The bands above are the exact cutoffs the binary enforces — don't paraphrase them elsewhere.

## Creative velocity check

On `dashboard` runs, check weekly creative count vs. target: **1–3 new creatives per $10K/week spend**. Surface shortfall in the briefing.

## Owned-channel target

On `dashboard`, check email + SMS contribution. Under 20% of revenue → recommend flows in order: welcome → browse abandon → cart abandon → post-purchase → win-back (full rubric in `merlin-social`).

## Routing hints

- "numbers" / "how we doing" / "performance" / "dashboard" → `dashboard({action: "dashboard"})`
- "why aren't ads converting" / "audit my page" / "landing page" → apply Conversion Rubric, run `landing-audit` if available
- "what should I do next" → `dashboard` + read `memory.md`, propose top action
- "marketing calendar" / "launch schedule" / "content gaps" → `dashboard({action: "calendar"})`
- "set a goal" / "target $50k this month" / "what's my goal" → `{"action": "goal-set"}` / `{"action": "goal-get"}`
- "am I on track" / "pacing" / "will I hit my target" → `dashboard` (goal block is included automatically)

## Cross-references

- Revenue source resolution → `merlin-ecom`
- Ad-specific performance + kill/scale decisions → `merlin-ads` (Promotion Gate)
- Email revenue attribution models → `merlin-social`
- SEO performance → `merlin-seo`
