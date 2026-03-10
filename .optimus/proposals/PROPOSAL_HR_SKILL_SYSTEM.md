# Title: HR & Skill Evolution System (Self-Improving Agent Loop)

## 1. Abstract
To enable the multi-agent system to continuously improve and adapt, we introduce the **HR (Skill Engineer/Trainer)** role. The HR agent does not "hire" external tools; instead, it synthesizes, researches, and solidifies new capabilities into reusable `[skill].md` plugins, expanding the toolset and knowledge base of the existing workers (`dev`, `architect`, `qa-engineer`).

## 2. The Triggers: How HR Identifies Need for New Skills

HR operates on four distinct trigger dimensions to know *when* and *what* to create:

### 2.1. Reactive (Exception-Driven): The "Block & Help" Protocol
- **Trigger:** When a `dev` or `qa-engineer` agent struggles with a task (e.g., repeatedly failing to interact with a new CLI, or lacking API knowledge for a 3rd-party service).
- **Mechanism:** The blocked agent pauses execution, logs the failure context in the local blackboard, and throws a `Missing-Capability` flag. 
- **HR Action:** HR reads the crash context, researches the target tool/API, writes a specific SOP, and creates a formal `.md` skill file (e.g., `aws_s3_upload.md`). HR then signals the blocked agent to resume.

### 2.2. Proactive (Post-Mortem & Analytics): The "Refactoring" Protocol
- **Trigger:** High repetition of sequential manual steps detected across multiple tasks.
- **Mechanism:** After PM closes a GitHub Epic, an async background Map-Reduce task triggers HR to read the `.optimus/logs/` of the completed PRs.
- **HR Action:** If HR notices the `dev` agent always types 6 specific manual terminal commands to configure a DB, HR extracts this pattern and packages it into a `db_setup` Skill. This prevents future token waste and error rates.

### 2.3. Strategic (PM & Architect-Driven): Pre-requisite Training
- **Trigger:** A new GitHub issue requires a completely new tech stack (e.g., "Migrate payment system to Stripe").
- **Mechanism:** During the "Plan & Architect" phase, the `architect` identifies dependencies missing from the current `resources/plugins/skills/` registry. 
- **HR Action:** The PM assigns a blocking issue directly to HR. HR researches the best practices for the new tech stack and generates the necessary Agent Instructions/Skills *before* the `dev` is ever invoked.

### 2.4. Manual (User-Driven): Explicit Command 
- **Trigger:** The human user wants to enforce a specific workflow or add a specialized sub-agent.
- **Mechanism:** User creates a GitHub issue tagged with `HR-Request`.
- **HR Action:** HR converts the user's plain-text request into a strict YAML/Markdown system prompt and skill interface.

## 3. The HR Delivery Pipeline

1. **Intake:** Consume the raw requirement or crash log.
2. **Research:** Use web-search or internal documentation reading tools to gather factual usage of the desired capability.
3. **Formulate:** Generate a strict parameter-driven interface and Markdown instruction.
4. **Deploy:** Deposit the newly generated `.md` file into `resources/plugins/skills/` (or `.optimus/registry/skills/`).
5. **Broadcast:** Update `.optimus/config/rules.md` or the `AGENTS.md` roster so the `pm` and `Master Agent` know this new capability exists.

## 4. Roster Definition

- **Name:** `hr-trainer`
- **Responsibilities:** Skill extraction, prompt tuning, system capability expansion, error-loop analysis.
- **Output Artifacts:** `*.md` files inside the skills directory. 
