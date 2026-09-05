# Trustgraphs v0.1.0 frontend review

Review date: 5 September 2026. Baseline commit: `a45687bfdf0cc5c3190aea9048b9ec79b24c3150`, plus the existing uncommitted frontend work present at review start. This reviews the prospective release, including the new governance builder and batch-vouch changes, rather than a tagged v0.1.0.

The visual direction is worth retaining: restrained colors, clear rules, a serif display face, and monospaced controls give the product a distinct identity. The largest gaps are in the application flows behind that presentation: trustworthy financial states, consistent wallet/network handling, accessible shared controls, and mobile forms. A redesign would be less valuable than applying the strongest existing patterns consistently.

The current frontend is not ready for mainnet. Its application-chain configuration only supports local and Sepolia, and several write paths do not enforce the configured chain. Resolve the transaction and amount-display findings before a public testnet release; use testnet to validate the remaining interaction and recovery work before mainnet.

## Scope and evidence

Three parallel subagent reviews covered user journeys, mobile/accessibility, and code quality. The primary review cross-checked findings, inspected the rendered application, and consolidated priorities. No application fixes, deployments, or wallet transactions were performed.

Source references are relative to this report and refer to the reviewed working tree. A later commit of the existing application changes can shift line numbers. Browser review uses an isolated copy of that tree and the app's opt-in review fixtures; it does not establish live-chain correctness or production-service availability.

## Release priorities

| ID | Priority | Finding | Release gate |
| --- | --- | --- | --- |
| F01 | P1 | Write actions do not consistently enforce the target chain | Before public testnet |
| F02 | P1 | Mainnet is not an application configuration target | Before mainnet |
| F03 | P1 | ERC20 fees and history use incorrect decimal precision | Before public testnet |
| F04 | P1 | Failed financial reads masquerade as empty or successful states | Before public testnet |
| F05 | P1 | Funding can be enabled while prerequisites are missing | Before public testnet |
| F06 | P1 | Shared switches and table actions are inaccessible from a keyboard | Before broad testnet UX validation |
| F07 | P2 | Creation drafts and step orientation need recovery support | Before mainnet |
| F08 | P2 | Mobile inputs and action layouts need consistent sizing | Before mainnet |
| F09 | P2 | Address/tooltip markup nests interactive elements | Before mainnet |
| F10 | P2 | Wallet connection and switch recovery are inconsistent | Before mainnet |
| F11 | P2 | Creation cost and first-proof copy overpromise | Before mainnet |
| F12 | P2 | Vouch signing exposes too much technical detail at once | Before mainnet |
| F13 | P2 | Landscape popups clip controls without a touch-scroll path | Before mainnet |
| F14 | P2 | Some small text and form labels fail accessibility checks | Before mainnet |

P1 denotes a release blocker for the stated gate. P2 denotes meaningful usability or reliability work, suitable for validation on testnet. Design recommendations are separated from confirmed defects below.

## Findings and recommended changes

### F01. Enforce the application chain for every write and receipt

**P1 · Source and dependency-mock verified.** The shared transaction helper forwards caller arguments without supplying a target `chainId`, then waits for a receipt without one ([chain.ts:63](../../packages/frontend/lib/chain.ts#L63)). Multiple callers omit it, including the payable funding action ([distribute/component.tsx:297](../../packages/frontend/app/networks/[id]/distribute/component.tsx#L297)). A wallet can change chains after connecting. The installed Wagmi implementation then uses the connection's chain, with chain assertion disabled when no chain ID was supplied.

A local harness intercepted the installed dependency's call: an unpinned payable action with a mocked wallet on Ethereum selected chain `1`, reported `assertChainId: false`, and retained its value. **No transaction was sent.** The wrong chain can mean unrelated addresses, misleading wallet prompts, failed calls, or sending native value somewhere unintended.

**Change:** Require the configured application chain in the shared write API and receipt lookup; refuse mismatches before signing and show a contextual switch action. Apply it to direct wallet/public-client calls as well. Keep ENS reads explicitly separate. Derive displayed balance and network name from the same chain. Test wallet switching after connection, between approval and funding, and while awaiting a receipt.

### F02. Implement a real mainnet application target

**P1 before mainnet · Source confirmed.** [generate-config.ts:33](../../packages/frontend/scripts/generate-config.ts#L33) rejects chains other than local/Sepolia. [wagmi.ts:38](../../packages/frontend/lib/wagmi.ts#L38) does the same, evaluating the result at module scope. The extra mainnet chain is used for ENS; it does not establish mainnet application support.

**Change:** Add the intended mainnet deployment chain through configuration generation, contract addresses, RPC routing, wallet connection, explorer links, and chain-specific persisted/query state. Test a mainnet-configured build separately from the Sepolia build. A clear persistent environment indicator will also help people distinguish testnet from mainnet when both are available.

### F03. Display ERC20 amounts using verified token precision

**P1 · Source and arithmetic verified.** Funding parses the submitted amount using token decimals, but displays its fee with hard-coded `18` decimals ([distribute/component.tsx:189](../../packages/frontend/app/networks/[id]/distribute/component.tsx#L189), [fee display:468](../../packages/frontend/app/networks/[id]/distribute/component.tsx#L468)). History formatting also defaults to 18, and its callers omit token decimals ([history:323](../../packages/frontend/app/networks/[id]/distribute/component.tsx#L323)).

For a six-decimal asset, a 100-token history entry becomes `0.0000000001 tokens`; the transaction amount is not reduced to match that display. The local installed-Viem calculation confirmed this scale error.

**Change:** Share token metadata and formatting between funding, fee quotes, history, and rewards. Show symbol and actual decimals per asset; represent unknown metadata explicitly. Add a regression covering six-decimal amounts and fees, and mixed-token history.

### F04. Preserve the distinction between “empty,” “unavailable,” and “already claimed”

**P1 · Source confirmed.** Rewards distribution and claim reads default to empty arrays and discard their errors ([rewards/component.tsx:83](../../packages/frontend/app/networks/[id]/rewards/component.tsx#L83)). Later UI can show “All caught up,” “No unclaimed rewards,” or “No rewards from this source yet” ([summary:413](../../packages/frontend/app/networks/[id]/rewards/component.tsx#L413), [source card:569](../../packages/frontend/app/networks/[id]/rewards/component.tsx#L569)). Similar paths exist in the legacy claim component and funding history. Failed claim-history reads can make an already-claimed reward look available.

**Change:** Give required reads explicit loading, success-empty, success-data, error, and stale states. On failure say **“We couldn’t check rewards”**, offer Retry, retain known data with its timestamp, and avoid claiming that eligibility or balance is known. Disable actions whose proof/claim state is unverified. Use the same distinction for first-proof status and settings health; absence of fetched data is not evidence that a service is healthy or a network has no scores.

**Acceptance:** After loading a funded/claimed account, fail distributions, claims, and proof reads independently, exhaust retries, and verify that none becomes a definitive zero/empty/healthy state. Repeat on a cold page load.

### F05. Make funding readiness explicit

**P1 · Source confirmed.** [handleDistribute:256](../../packages/frontend/app/networks/[id]/distribute/component.tsx#L256) returns silently when fee amount/recipient is missing, but [the button:492](../../packages/frontend/app/networks/[id]/distribute/component.tsx#L492) does not require those reads to succeed. Token decimals also default to 18 before metadata has been verified; approval can therefore be prepared from an assumption.

**Change:** Derive one funding-readiness state for both the handler and UI: correct wallet/chain, valid token, verified precision, fee terms, amount, allowance, and proof. Show **“Loading fee…”** or **“Couldn’t load token details · Retry”** beside the action. Only parse/approve a token amount once metadata is known. Preserve input when a prerequisite fails.

### F06. Replace mouse-only controls with semantic controls

**P1 for public usability · Source confirmed.** [Switch.tsx:26](../../packages/frontend/components/Switch.tsx#L26) uses a clickable `div` without keyboard behavior, a switch role, accessible name, or checked state. Creation uses it for shared funds and signer sync ([AddOnsStep.tsx:164](../../packages/frontend/app/create/steps/AddOnsStep.tsx#L164)). Keyboard users cannot enable those capabilities.

[Table.tsx:180](../../packages/frontend/components/Table.tsx#L180) implements sorting on a `th` click and row navigation on a `tr` click. Proposal titles are plain text, so the governance list provides no keyboard-operable proposal link ([governance/page.tsx:161](../../packages/frontend/app/networks/[id]/governance/page.tsx#L161), [row handler:348](../../packages/frontend/app/networks/[id]/governance/page.tsx#L348)). Attestation cards have a similar click-only detail action.

**Change:** Use a named native button/switch primitive with checked state; use real links for record titles; put sortable header labels inside buttons and expose `aria-sort`. Keep address/copy actions independent. A whole row should not become another interactive wrapper around its existing controls. The [W3C sortable-table example](https://www.w3.org/WAI/ARIA/apg/patterns/table/examples/sortable-table/) provides the appropriate pattern.

### F07. Preserve creation drafts and orient people at each step

**P2 · Source confirmed.** Standard creation keeps its draft, step, pinned metadata, and salt only in component state ([create/component.tsx:55](../../packages/frontend/app/create/component.tsx#L55)). Refreshing or leaving loses them. Step changes and validation only update state ([next/back:157](../../packages/frontend/app/create/component.tsx#L157)); they do not focus the new heading or the first invalid field. The shared Field helper does not connect its hint/error to the input ([create/ui.tsx:40](../../packages/frontend/app/create/ui.tsx#L40)).

**Change:** Reuse the governance builder's existing saved-draft and focus patterns. Scope drafts to chain, wallet/parent where appropriate, persist the creation salt, expose Restore/Discard, and clear only after confirmed creation. Focus the first invalid field on error and the next step heading on continuation; mark `aria-current="step"` and associate hints/errors. Review weighted/composition drafts under the same standard.

**Browser confirmation:** At 320px, tapping Continue with an empty name retained focus on Continue, at scroll position 833px; the invalid Name field was 422px above the viewport. Its error existed but was not visible near the action and had no `aria-invalid`/`aria-describedby` association. After a valid transition, the next heading remained 273px above the viewport. See [invalid-name screenshot](frontend-v0.1.0-evidence/mobile-invalid-name-320.png).

### F08. Finish the shared mobile form rules

**P2 · Source confirmed; browser measurements below.** The coarse-pointer 16px rule only selects inputs with explicit `type` attributes ([globals.css:431](../../packages/frontend/app/globals.css#L431)). [Input.tsx:8](../../packages/frontend/components/Input.tsx#L8) leaves `type` absent by default. Creation name, image, and application inputs omit it ([IdentityStep.tsx:49](../../packages/frontend/app/create/steps/IdentityStep.tsx#L49)), leaving normal text fields outside that rule. This defeats the intended protection against iPhone focus zoom; real-device keyboard behavior still needs testing.

The shared button sizes also range from 24 to 36px while the main navigation explicitly uses 44px ([Button.tsx:45](../../packages/frontend/components/Button.tsx#L45)). Long busy labels and fixed-width slider rows need particular attention at 320px.

**Change:** Default Input to `type="text"`, cover type-less native inputs, use URL/email/decimal semantics, and retain pinch zoom. Give primary standalone controls a consistent 44px touch area; allow explicit compact desktop variants. Make footers wrap or stack and give busy labels a bounded multiline treatment. Stack slider label/control/value groups on narrow screens.

The 44px recommendation is a product comfort target. [WCAG 2.2 AA target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) generally uses 24 CSS px, with spacing and other exceptions; a 32px button is not automatically an AA failure. Check page reflow at 320 CSS px while allowing contained two-dimensional graphs/tables to scroll ([W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)).

**Browser confirmation:** All three identity inputs computed to 12px with a coarse pointer. During an intercepted metadata save, “Saving your description…” widened a 320px page to 378px and clipped the button. The advanced scoring step widened it to 324px; a long slider label occupied only 66.6px horizontally and wrapped into an 88px-tall column. Compare document width against the configured viewport/client width, since mobile overflow can also enlarge `window.innerWidth` and fool a naive check. See [busy-button screenshot](frontend-v0.1.0-evidence/mobile-saving-overflow-320.png) and [scoring screenshot](frontend-v0.1.0-evidence/mobile-scoring-320.png). Relevant layout sources: [wizard footer:335](../../packages/frontend/app/create/component.tsx#L335) and [PercentSetting:110](../../packages/frontend/app/create/ui.tsx#L110).

### F09. Separate address links, copy buttons, and help triggers

**P2 · Source confirmed.** [Address.tsx:182](../../packages/frontend/components/Address.tsx#L182) calls Tooltip without `asChild`; an ENS name or explicit tooltip makes [Tooltip.tsx:35](../../packages/frontend/components/Tooltip.tsx#L35) wrap the address in a trigger button. The address itself contains a link and a copy button. Even without the tooltip, copy is inside the link. This produces nested interactive controls, with additional DOM/hydration risk when the outer trigger appears. Copy is also a 12px icon hidden until hover/focus.

**Change:** Use a noninteractive wrapper with sibling address-link and copy-button controls. Attach help to one valid trigger, preserve the link's accessible name, and show a usable copy target on touchscreens. Verify before/after ENS resolution and all link/copy/tooltip combinations.

### F10. Give wallet prerequisites and failures a visible next action

**P2 · Source confirmed.** The network's vouch action is disabled when disconnected, with its reason in a tooltip on the disabled trigger ([CreateAttestationModal.tsx:333](../../packages/frontend/components/CreateAttestationModal.tsx#L333)). Mobile/keyboard users cannot reliably discover that explanation. Network-switch errors are caught, followed by an add-network/retry attempt regardless of why switching failed, then logged without useful UI feedback ([WalletConnectionProvider.tsx:72](../../packages/frontend/components/WalletConnectionProvider.tsx#L72)). Add-network uses `window.ethereum`, which may not be the active connector.

**Change:** Offer **Connect to vouch** in context and preserve the intended action. Treat user rejection as cancellation; only add an unknown chain when the connector reports that specific condition. Use the active connector, return a meaningful switch result, and show Retry or concise manual-switch guidance. The contextual wallet action already present on rewards is a good shared pattern.

### F11. Make cost and first-proof promises match actual state

**P2 · Source confirmed.** Creation can send optional prepaid ETH ([ReviewStep.tsx:318](../../packages/frontend/app/create/steps/ReviewStep.tsx#L318)) while the final note says the user pays the transaction fee “and nothing else” ([cost note:676](../../packages/frontend/app/create/steps/ReviewStep.tsx#L676)). The success screen promises a scheduled first proof from the cadence, regardless of whether proof funding/service availability establishes that guarantee ([SuccessStep.tsx:31](../../packages/frontend/app/create/steps/SuccessStep.tsx#L31)).

**Change:** Put one accurate total beside signing: **“Creates the network and adds X ETH to its proof balance, plus gas”**, or **“Gas only.”** Present indexing and the first score update as separate states with real readiness/funding information. Describe cadence as update eligibility unless the service actually guarantees scheduling. Lead success with a shareable network link and next action; place contract addresses in expandable details.

### F12. Make gasless vouching a short guided signing flow

**P2 · Source-confirmed layout/copy; design judgment.** The gasless flow exposes EOA/EAS/relay internals in its mode description and full typed-message data, salt, predecessor, commitments, and CIDs in the main signing view ([CreateAttestationModal.tsx:511](../../packages/frontend/components/CreateAttestationModal.tsx#L511), [review panels:813](../../packages/frontend/components/CreateAttestationModal.tsx#L813)). Fixed `8rem` label columns leave little room for values on phones. Its fallback can also say “Select a schema to attest to” during an existing review ([fallback:995](../../packages/frontend/components/CreateAttestationModal.tsx#L995)).

**Change:** Lead with recipient, confidence, comment, public visibility, and **Sign vouch → Authorize publication → Recorded**. Explain signatures remaining and who pays gas. Keep exact signed fields available under Technical details, stacked on mobile. Remove the contradictory schema prompt during signing. Preserve the existing distinction between a recorded vouch and later score publication.

### F13. Allow small-screen popups to flip or scroll

**P2 · Browser and source verified.** [Popup.tsx:326](../../packages/frontend/components/Popup.tsx#L326) forces hidden overflow. [useTrackDropdown.ts:106](../../packages/frontend/hooks/useTrackDropdown.ts#L106) clamps a below-trigger panel at the viewport bottom without moving it above the trigger or giving it a scrollable region.

At 844×390, the open simulation popup had 173px of usable height for 261px of content with `overflow-y: hidden`. Trust Decay extended below the screen; Max Iterations was entirely below it. The panel also had no accessible label. See [landscape screenshot](frontend-v0.1.0-evidence/mobile-popup-bottom-landscape.png).

**Change:** Use a shared collision-aware popover with flipping, a bounded scrolling region, an accessible name, and expanded/controls relationships on its trigger. Verify all fields remain touch- and keyboard-reachable near every viewport edge, including when a mobile keyboard is open.

### F14. Validate contrast on actual surfaces and connect visible labels

**P2 · Browser and source verified.** The dark homepage and proposal action-library header use small subtle text on `surface-2`, which axe measured at 4.31:1, below the 4.5:1 small-text threshold. Two inverted homepage eyebrow labels measured 4.2:1 because of opacity. The token comments describe contrast against the page background, which does not guarantee contrast on cards ([tokens.css:97](../../packages/frontend/app/tokens.css#L97), [homepage opacity:290](../../packages/frontend/app/page.tsx#L290), [action-library header:113](../../packages/frontend/components/GovernanceActionLibrary.tsx#L113)).

The funding token selector has no accessible name: its visible Label has no `htmlFor`, and its trigger has no matching ID/name ([distribute/component.tsx:429](../../packages/frontend/app/networks/[id]/distribute/component.tsx#L429)). The verification and sort selects on attestations similarly lack label associations ([attestations/page.tsx:74](../../packages/frontend/app/attestations/page.tsx#L74)). Both theme scans caught the unnamed controls.

**Change:** Test text/background token pairs across every surface and avoid opacity for essential small text. Associate each visible field label with its control. Include both themes and actual error/hover/selected states in automated accessibility checks; passing a static axe scan alone does not establish keyboard usability.

## Design direction: make the existing system feel finished

These are design recommendations rather than additional release-blocking defects.

1. **Give every first screen a clear purpose and next action.** Keep the graph-led landing page, but render the explanation and Explore/Create actions independently of the live graph. A possible subhead is “Turn community vouches into reputation your members can use.” The unavailable-graph message invites browsing networks without providing a direct link ([HeroGraphUnavailable.tsx:21](../../packages/frontend/app/HeroGraphUnavailable.tsx#L21)); add one. Keep the graph legend short and visible.

2. **Bring members and participation closer to the top on mobile.** The network graph has a 38rem/608px minimum height before the member table ([network overview:221](../../packages/frontend/app/networks/[id]/component.tsx#L221)). At 390px the member section began below the first screen, and its score column required horizontal scrolling past secondary columns. Show rank, member, and score together in the mobile row/card; put secondary details behind expansion. On hybrid networks, a full audit table is also above members ([HybridVouchAudit.tsx:26](../../packages/frontend/components/HybridVouchAudit.tsx#L26)). Consider Members/Graph views, a visible jump to members, and a shorter mobile graph with Expand. Put provenance under “How these scores were verified,” after primary participation content. Preserve the large desktop graph and access to full audit information. See [current mobile overview](frontend-v0.1.0-evidence/overview-390-dark.png).

3. **Standardize a small set of page and form primitives.** Reuse one page-heading scale, section spacing, label/hint/error contract, action bar, empty state, and transaction-status panel. The existing serif/mono pairing and restrained palette already supply identity; consistency should come from spacing, hierarchy, and behavior. Keep uppercase control styling intentional; avoid using all-caps for whole explanatory messages. Raise small operational text and touch areas where readability requires it. Replace the hard-coded light-gray info icon with a theme token ([InfoTooltip.tsx:20](../../packages/frontend/components/InfoTooltip.tsx#L20)).

4. **Use the member's vocabulary consistently.** For vouch schemas, use “Vouch for someone,” “Review vouch,” “Vouch recorded,” and “Scores update next.” Keep “attestation” for generic schemas and protocol records. The current journey switches between vouch and Make Attestation ([network overview:207](../../packages/frontend/app/networks/[id]/component.tsx#L207), [CreateVouchingSchema.tsx:201](../../packages/frontend/components/schema-components/CreateVouchingSchema.tsx#L201)). Centralize schema-specific action labels. Make loading/error/empty copy follow situation → meaning → action.

5. **Remove unnecessary choices; disclose advanced details when useful.** If only standard creation is available, the chooser should become a useful start screen or go directly to step one ([chooser.tsx:30](../../packages/frontend/app/create/chooser.tsx#L30)). Say what the user needs and what happens next. When several creation modes exist, keep community vouching prominent and explain other modes by outcome. Default settings, creation success, and signing screens should answer user decisions first, with addresses/encoding/provenance in expandable details.

6. **Give transactions durable follow-through.** Shared toasts are too transient for multi-transaction operations such as Claim all ([tx.ts:51](../../packages/frontend/lib/tx.ts#L51), [rewards/component.tsx:375](../../packages/frontend/app/networks/[id]/rewards/component.tsx#L375)). Show chain, transaction link, confirmation state, “2 of 4,” and recoverable partial success. Preserve the confirmed local result while the indexer catches up. The vouch flow already models recorded-versus-scored state; extend that approach.

## Code quality and maintainability

The domain test corpus is a strength: deterministic scoring, encoding, governance actions, and program-specific golden vectors have substantial coverage. Catalog fallback behavior, lazy wallet SDK loading, the newer governance draft/review flow, and the distinction between vouch confirmation and score publication are good internal patterns to extend.

Three improvements deserve attention:

- **Move scoring simulations off the render thread.** [settings/scoring.tsx:1255](../../packages/frontend/app/networks/[id]/settings/scoring.tsx#L1255) calls the full before/after preview synchronously from `useMemo`; [scoring-preview.ts:110](../../packages/frontend/lib/scoring-preview.ts#L110) recomputes both outputs. Single synthetic Node runs measured 144ms for 100 nodes/300 edges, 358ms for 500/1,500, and 1,011ms for 2,000/6,000. These are directional timings on a busy review machine, not mobile benchmarks. Use a cancellable worker, cache the unchanged baseline, debounce draft updates, and retain the last preview. A worker pattern already exists in weighted-prior previews.
- **Extract behavioral boundaries before reorganizing every file.** Settings is 3,386 lines, its scoring screen 2,801, composition creation 2,316, and weighted creation 2,146. Length alone is not a defect, but these screens mix reads, permissions, encoding, draft storage, transactions, computation, and presentation. Start with shared chain enforcement, financial read states, draft storage, and transaction lifecycle; then split visible sections. This addresses actual defects without a risky pre-release rewrite.
- **Make release checks match the UI being shipped.** Production builds skip TypeScript validation ([next.config.mjs:9](../../packages/frontend/next.config.mjs#L9)); a separate CI typecheck exists and should remain required. The screenshot harness invokes `next build` without `--webpack` ([shots.mjs:254](../../packages/frontend/scripts/shots.mjs#L254)); installed Next 16 config validation reproduced an exit because this app has custom Webpack configuration. Align it with the package's real build command. Add the governance/wallet/mobile smoke paths to the release gate and repair lint. Existing EAS assurance CI already exercises browser creation/replacement/revocation; retain and extend that coverage. Add hook/accessibility lint rules gradually and update the stale frontend contributor guidance.

## Suggested implementation order

| Pass | Deliverable | Demonstration of completion |
| --- | --- | --- |
| 1. Transaction correctness | Target-chain boundary, token precision, funding readiness, truthful financial states | Wrong-chain and failed-read scenarios cannot lead to misleading amounts or enabled unsafe actions; six-decimal fee/history regression passes |
| 2. Shared interactions | Semantic switches/tables, valid address controls, mobile inputs, visible wallet recovery | Keyboard-only create/propose/vouch navigation; independent copy/link actions; all text inputs readable on a coarse pointer |
| 3. Mobile task completion | Draft recovery, focused step transitions, responsive busy footers/sliders/popups, compact network overview | Complete a creation/proposal journey at 320/390px, interrupt it with wallet app switching, then resume without losing context |
| 4. Polish and release qualification | Consistent wording/spacing/states, simplified signing, worker previews, complete checks | Reviewed light/dark screenshots, forced failure states, real-device wallet tests, and separate Sepolia/mainnet build qualification |

## Testnet acceptance checklist

- [ ] Connected wallet starts on the wrong chain; changes chain after preview; changes between approval and funding; changes while awaiting confirmation.
- [ ] Wallet rejection, disconnect, mobile app switching, replacement/cancellation, and partial completion of Claim all have clear outcomes.
- [ ] Six-decimal ERC20 fee, approval, amount, and mixed-token history agree with transaction values.
- [ ] Indexer/RPC/proof/token-metadata failures never become zero balances, no rewards, or healthy status; retry preserves input and useful data.
- [ ] Create, restore draft, review, vouch/revoke, propose, and fund/claim work with keyboard-only navigation.
- [ ] Check 320, 390, 768, and desktop widths; phone landscape; light/dark mode; text zoom; reduced motion; long names/addresses and error messages.
- [ ] On actual iOS Safari and Android Chrome, test keyboard opening, focus zoom, safe areas, wallet deep links, and returning to the draft.
- [ ] Verify one populated network, an empty new network, pending first proof, stale scores, funded rewards, already-claimed rewards, and unavailable services.
- [ ] Run the supported toolchain from a clean install, repair lint, run domain tests, repair/run screenshot tooling, and require relevant browser acceptance on the release commit.
- [ ] Qualify the intended mainnet configuration separately; mainnet ENS support is not sufficient.

## Verification performed

| Check | Result | Qualification |
| --- | --- | --- |
| Fresh production compilation | Passed; 63 static pages generated | Isolated copy of current source, `next build --webpack`, development configuration and opt-in review fixtures. Platform-matched CSS binaries were provided through a temporary dependency path. No source/lockfile repair was applied. Builds intentionally skip typechecking. |
| Baseline browser matrix | 90/90 samples returned HTTP 200; no uncaught page errors or page-wide overflow | 15 route states; dark at 320×720, 390×844, 768×1024, 1440×1000; light at 390×844 and 1440×1000. This is an initial-state check, not proof that every interaction is responsive. |
| Targeted mobile interactions | Confirmed F07/F08/F13 | Validation and next-step focus, 12px inputs, 378px busy-state page width, 324px scoring width, clipped landscape popup. Metadata upload was intercepted locally; nothing was pinned or signed. |
| Automated accessibility | Findings in F14 | Axe 4.10.3 on all 15 route states at 390px dark and 1440px light. Keyboard-only defects were also found by source/interaction review. This is not a full accessibility conformance assessment. |
| Governance browser journey | Passed with connected-fixture adaptation | The existing smoke expects a disconnected wallet and initially stopped at that assumption. A temporary copy changed only that expectation to the connected mock's disabled Submit affordance. Remaining validation, action editing, search/filter, undo, autosave/reload, legacy routing, draft isolation, review, and 320/390/768/1024px checks passed. Submit was never clicked. |
| Frontend lint | Failed: 47 errors, 0 warnings; 40 potentially auto-fixable | Mostly import/formatting issues; two concern generated `next-env.d.ts`. This is an existing-tree result, not a report-file lint failure. |
| Intended compiler/default test command | Environment blocked | The installed TS7 executable lacked its Linux ARM64 optional binary; later tsx execution encountered a Darwin ARM64 esbuild installation. Do not count these intended commands as passing. |
| Compatibility typecheck | Passed | `node node_modules/typescript/bin/tsc6 --noEmit --incremental false`, reporting TypeScript 6.0.3. |
| Existing test logic through fallbacks | Passed | Compiled action/domain suites ran with the TS6 compatibility compiler; the final six source test files ran through Node type stripping or TS6 emission: 18 tests, 0 failures. A clean supported-toolchain run remains a release requirement. |
| Chain selection and precision | Confirmed F01/F03 | Installed-dependency mock and local formatting calculations; no RPC write or transaction. |

The 15 route states were `/`, `/networks`, `/create`, `/create/standard`, `/create/weighted`, `/create/composition`, `/faq`, `/docs/learn/what-is-trustgraphs`, `/networks/demo-co-op`, its governance list and new-proposal page, rewards closed/open funding, settings, and `/attestations`. The composition route showed the configured unavailable state. The mock-wallet/review-fixture build deliberately changes data availability and connection behavior; it cannot validate live reward eligibility, service failures, or real wallet signing. Financial failed-read findings are source-confirmed, not injected-outage browser reproductions.

The current frontend source was compared with the isolated build snapshot after the review; no differences were found in app/components/hooks/lib/queries/state/contexts/scripts. Real iOS/Android devices, assistive-technology sessions, production-size graphs, live wallet transactions, and mainnet configuration were not exercised. Those are explicit follow-up gates above.

## Evidence and review illustrations

- [Route matrix and accessibility findings](frontend-v0.1.0-evidence/route-matrix.json).
- [Targeted mobile measurements](frontend-v0.1.0-evidence/mobile-targeted-results.json).
- [Governance smoke result and fixture adaptation](frontend-v0.1.0-evidence/governance-fixture-smoke.txt).
- [320px validation error above the viewport](frontend-v0.1.0-evidence/mobile-invalid-name-320.png).
- [320px busy action clipping](frontend-v0.1.0-evidence/mobile-saving-overflow-320.png).
- [320px scoring layout](frontend-v0.1.0-evidence/mobile-scoring-320.png).
- [844×390 clipped simulation popup](frontend-v0.1.0-evidence/mobile-popup-bottom-landscape.png).
- [390px network overview](frontend-v0.1.0-evidence/overview-390-dark.png).
- [390px creation form in light mode](frontend-v0.1.0-evidence/standard-390-light.png).
- [320px proposal review, a stronger internal pattern](frontend-v0.1.0-evidence/governance-review-320.png).

These selected screenshots and measurements are intentional review documentation. No generated build output, dependency binaries, environment files, real wallet secrets, or prover artifacts are included.
