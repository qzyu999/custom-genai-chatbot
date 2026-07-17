# Chat UX Specification — Expected Behaviors

All permutations of chat mode, investigation mode, and transitions between them.

---

## Modes

| Mode | Trigger | Visual Indicator |
|------|---------|------------------|
| **Chat** | Default, or left toggle button active | Normal input, arrow send button |
| **Investigate** | Right toggle button (🔬+) active | Purple gradient send button, placeholder changes |

---

## Scenario Matrix

### S1: Start in Chat mode, ask a simple question

**Steps:**
1. User types question in chat mode
2. Presses Enter / clicks Send

**Expected:**
- User bubble appears immediately with their text
- Typing indicator shows ("Typing...")
- LLM response streams in progressively
- Response saved to history
- User can continue asking

---

### S2: Start in Chat mode, ask a complex question (triggers suggestion)

**Steps:**
1. User types complex question (matches heuristic: "analyze", "correlate", "trend over 6 months", "deep dive")
2. Presses Enter

**Expected:**
- Normal chat generation starts immediately (response streams)
- Suggestion banner appears asynchronously below input: "This looks like a multi-step analysis..."
- Banner has [Investigate] and [Dismiss] buttons
- Normal response continues streaming while banner is visible

**S2a: User dismisses suggestion**
- Banner disappears
- Normal chat response completes as usual
- No investigation triggered

**S2b: User accepts suggestion while response is streaming**
- In-progress generation is cancelled (partial response discarded)
- User message bubble remains visible (not cleared)
- Investigation starts for the same question
- `handleInvestigate` persists the user message to chat history (since generate was aborted before saving)
- No duplicate user message: local bubble clears after DB refetch settles (~500ms)
- Investigation panel appears, summary streams after
- Final state: user bubble (from DB) → investigation panel → LLM summary

**S2c: User accepts suggestion after response completed**
- Normal response is already saved in chat history
- Investigation starts for the same question
- User message already in history — `handleInvestigate` skips saving (alreadyInHistory check)
- Investigation panel + summary appear as a new turn below the chat response
- Result: user question → chat response → investigation panel → investigation summary

---

### S3: Start in Investigate mode from Dashboard

**Steps:**
1. User toggles to Investigate on dashboard input
2. Types question, presses Enter

**Expected:**
- Chat is created with user's text as first message
- Navigates to chat page with `autoInvestigate: true`
- User bubble appears with 🔬 badge and purple border
- Investigation panel appears (steps animate)
- Status: spinner + "Investigating..."
- On completion: banner switches to "Preparing summary..." then "Summarizing findings..."
- LLM summary streams in below the panel
- Summary saved to chat history
- Panel stays collapsed/expandable
- User can continue asking

---

### S4: Start in Investigate mode from within a chat

**Steps:**
1. User is in an existing chat (may have prior messages)
2. Toggles to Investigate mode
3. Types question, presses Enter

**Expected:**
- User message saved to chat history (appears as user bubble with 🔬 badge)
- Investigation panel appears below user bubble
- Steps animate with spinners
- On completion: "Preparing summary..." → "Summarizing findings..."
- LLM summary streams in
- Summary saved to chat history as model message
- Panel collapses, summary visible as bot bubble
- User can continue

---

### S5: Multiple investigations in same chat

**Steps:**
1. User does investigation #1 (completes with summary)
2. User does investigation #2

**Expected:**
- Investigation #1: user bubble → panel (collapsed) → bot summary
- Investigation #2: user bubble → panel (active, animating) → bot summary
- Both panels remain in the conversation inline, collapsible
- Panels render below their respective user messages
- AI can reference prior investigation results

---

### S6: Switch from Chat to Investigate mid-conversation

**Steps:**
1. User asks a normal chat question (gets response)
2. User toggles to Investigate mode
3. Asks investigation question

**Expected:**
- Normal chat: user bubble → bot bubble (no panel)
- Investigation: user bubble (🔬 badge) → panel → bot summary
- Conversation flows naturally top-to-bottom
- AI context includes both the normal chat and investigation results

---

### S7: Switch from Investigate to Chat mid-conversation

**Steps:**
1. User does an investigation (gets panel + summary)
2. User toggles back to Chat mode
3. Asks a follow-up question about the investigation

**Expected:**
- Follow-up: normal user bubble → LLM response (streams)
- LLM can reference the investigation summary (it's in chat history)
- No investigation panel for this turn

---

### S8: Cancel investigation mid-flight

**Steps:**
1. User starts an investigation
2. Clicks Cancel on the panel while steps are running

**Expected:**
- Investigation aborts (SSE connection closed)
- Panel shows "Failed" badge
- No LLM summary is generated
- User can submit again (fresh investigation or switch to chat)

---

### S9: Investigation from dashboard with first message being investigation

**Steps:**
1. Fresh start: user opens app, types in dashboard, Investigate mode selected
2. Submits

**Expected:**
- Single user message in history (no duplicate)
- Investigation runs
- Summary appears
- User message has 🔬 badge

---

### S10: Normal chat from dashboard

**Steps:**
1. User types in dashboard, Chat mode (default)
2. Submits

**Expected:**
- Chat created, navigates to chat page
- Auto-generates LLM response (streams)
- Standard flow, no investigation panel

---

### S11: Suggestion trigger keywords in chat mode

**Steps:**
1. User is in chat mode (default)
2. Types a message containing a trigger word: "deep dive", "analyze", "correlate", "trend", "compare", "break down", "comprehensive", "multi-step", "end-to-end", "investigate", or "over the past/last N"
3. Presses Enter

**Expected:**
- Normal LLM response begins streaming immediately
- Suggestion banner appears asynchronously (non-blocking)
- Banner text: "This looks like a multi-step analysis that would benefit from an investigation."
- Banner buttons: [Investigate] [Dismiss]
- LLM response continues uninterrupted while banner is visible
- If user ignores banner: it persists until dismissed or accepted
- Only one banner at a time (new trigger replaces old)

**S11a: User does nothing (ignores banner)**
- Response completes normally
- Banner stays until next action or dismiss
- No investigation triggered

**S11b: User clicks Dismiss**
- Banner disappears
- Chat response continues/completed as normal

**S11c: User accepts, response was still streaming**
- Response stream cancelled, partial text discarded (not saved)
- User bubble remains visible throughout
- Investigation starts, user message persisted by `handleInvestigate`
- After ~500ms local bubble state clears (DB version takes over)
- Panel + summary follow

**S11d: User accepts, response already completed**
- Chat response already saved in history (visible as bot bubble)
- Investigation starts — user message already in history (skip save)
- Panel + summary appear below the existing chat response
- Result: user → chat response → panel → investigation summary (4 items for one question)

---

## State Invariants

These must always hold:

1. **No duplicate user messages** — Each user submission creates exactly ONE user entry in chat history
2. **Panel position** — Investigation panel always renders directly below its triggering user message
3. **Active panel uniqueness** — Only one investigation can be active at a time
4. **Completed panels persist** — Completed investigation panels remain collapsible in conversation
5. **AI continuity** — Every investigation summary is saved to chat history so the LLM sees it in context
6. **Mode independence** — Switching modes doesn't affect rendering of prior messages
7. **Streaming visibility** — During any LLM generation (chat or investigation summary), text streams progressively with a status indicator
8. **No dead states** — There's always visual feedback: typing indicator, investigation steps, status banner, or idle input

---

## Known Edge Cases

- **Same question twice**: If user asks the same investigation question twice, both panels should render independently (matched by position, not just text)
- **Empty investigation result**: If investigation returns no summary, skip LLM generation and show error
- **LLM failure during summary**: Show error state, investigation panel still visible with raw data
- **Rapid mode switching**: Toggling between chat/investigate rapidly shouldn't corrupt state
- **Page reload during investigation**: Active investigation is lost (not persisted), completed panels are also lost (session-only state). Chat history messages persist.
- **Suggestion accepted mid-stream**: Cancels the in-flight chat generation cleanly, no partial response saved, investigation starts fresh
- **Suggestion accepted after stream complete**: Both the chat response AND investigation exist in history — this is intentional (chat gave quick answer, investigation gives deep analysis)
- **Multiple suggestions in a row**: Only one suggestion banner shows at a time (new one replaces old)
- **Suggestion for same text as prior investigation**: `alreadyInHistory` may match — investigation still runs but no duplicate user message saved
