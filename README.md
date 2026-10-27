# Here Lies

*Every impulse buy you talked yourself out of.*

Here Lies is a soft-luxury web app that helps people stop impulse shopping. Instead of checking out, you log what you want and why, and it goes to a waiting room or to your safe person for approval. Everything you let go of is laid to rest in the Wishlist Graveyard, and the money you kept counts toward a reward you choose.

## Features

- **Create your profile:** a six-step onboarding covering your name, why you're here, your weak spots, triggers and risky times, budget, safe person and coaching style. It ends with a profile card.
- **I want something:** log the item, price, category and a required reason before anything moves forward.
  - **Screenshot it:** upload a screenshot from TikTok, Instagram or a store and AI fills in the product, price and category.
  - **"Do I need this?" coach:** an AI coach asks up to three honest questions and gives a verdict, using your profile, the time of day and the tone you picked.
- **Waiting room:** items under your limit wait 24 to 72 hours, with an extra day for your weak-spot categories.
- **Safe person:** items over your limit generate a custom "check me" message to send to your buddy, then you record their yes, no or wait-a-week.
- **Streaks:** nightly no-buy streak, one freeze per month, and a monthly streak calendar with stats.
- **Reward fund:** money kept adds up toward a planned, guilt-free purchase that unlocks at 30 nights.
- **Fun-money budget:** tracks what you've spent this month against your limit.
- **Themed challenges:** No Makeup November, Shop Your Closet Week, Use It Up Month, and 7, 30 and 90-day no-buys, with badges.
- **Wishlist Graveyard:** every item you let go of as a headstone with its price, dates and "last words," plus a 30-day resurrection check.
- Loading screen, sidebar dashboard layout, and a phone layout with a slide-out menu.

## Tech

- A single self-contained `index.html`: HTML, CSS and vanilla JavaScript, with no build step.
- Fonts: Fraunces and Jost from Google Fonts.
- Illustrations are hand-written inline SVG with CSS animation.
- When run inside Claude, it uses Claude's artifact runtime (`window.claude`) for account-synced storage and the AI coach and screenshot reader.
- When run anywhere else, data saves to the browser's `localStorage`, and the AI coach and screenshot upload are hidden.

## Run it

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Roadmap

- A small backend (for example a serverless function calling the Claude API) so the AI coach and screenshot reader work on the public site
- Real buddy accounts with an approval inbox
- Insights page and an AI-written monthly letter
- "You already own this" inventory
- Installable app (PWA) with reminders
