# The design stage: how Lair designs what users see and do

> Status: design. Roadmap: [ROADMAP.md](ROADMAP.md) C3 (documents first) and C4 (kickstart). Related:
> [app-architecture.md](app-architecture.md), [quality.md §9](quality.md) (real use: exploratory testing and UX),
> [ai-roles.md](ai-roles.md).

An enterprise-grade application is judged by the people who use it. Before builder agents write screens, Lair runs a
design stage beside the architecture stage: it turns the product description into users, journeys and screens, keeps a
design system the code must follow, and checks every change against both. Agents do the work (a designer role,
critiqued by reviewer roles and checked by tests); the owner decides taste, brand and anything that changes what the
product promises.

## What the stage produces
- **Users and journeys:** the personas, their jobs to be done, and numbered journeys (sign up, first value, the main
  daily task, billing, failure and recovery paths), each with its success measure.
- **Information architecture:** navigation, screens per journey, permissions per role, empty, loading and error states
  for every screen.
- **A design system:** tokens (colour, type, spacing, motion) with light and dark themes, components with their states
  and accessibility rules, content guidelines (voice, error messages), all as code in the repository so the build uses
  them directly. An existing brand or design tool (for example Figma) is imported instead of invented.
- **Screens and prototypes:** low-fidelity first, then high-fidelity for the journeys that matter most, linked to the
  journeys and to the components they use.
- **Acceptance per journey:** what a reviewer or a test checks (the journey completes, every state is reachable and
  readable, keyboard and screen reader work, it fits a phone).

## How the stage runs
1. **Gather.** The designer agent drafts users, journeys and screens from the owner's description (or from an existing
   product's screens and analytics) and asks one Decision Inbox item with the questions only the owner can answer
   (brand, tone, must-have flows).
2. **Propose.** Two or three directions for the look and the main flows, each with a few key screens.
3. **Critique.** Reviewer roles check usability heuristics, accessibility (WCAG level AA by default), consistency with
   the design system, and fit with the architecture (what the backend can serve, how fast).
4. **Decide.** The owner picks a direction; the rest follows the review policy.
5. **Freeze and enforce.** The design system and the journey acceptance are merged first. From then on gates check
   that UI changes use the system's tokens and components, pass automated accessibility checks, keep visual snapshots
   unless a reviewed change updates them, and pass the journey tests.
6. **Evolve.** Real use (analytics, support, exploratory testing in [quality.md §9](quality.md)) feeds back as design
   changes through the same loop.

## Acceptance (summary)
- From a one-page product description, Lair produces the journeys, screens and a design system in the repository, and
  every screen in the build traces to a journey.
- A pull request that adds a hard-coded colour or an inaccessible control fails its gate with the rule named.
- Two descriptions for different users (an internal tool for experts, a consumer app on phones) lead to different,
  justified designs, checked on a fixed evaluation set of product briefs.
