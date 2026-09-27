import { useState } from "react";
import { Concept01Query } from "./concepts/Concept01Query";
import { Concept02Options } from "./concepts/Concept02Options";
import { Concept03Tools } from "./concepts/Concept03Tools";
import { Concept04Permissions } from "./concepts/Concept04Permissions";
import { Concept05CustomTools } from "./concepts/Concept05CustomTools";
import { Concept06Sessions } from "./concepts/Concept06Sessions";
import { Concept07Hooks } from "./concepts/Concept07Hooks";
import { Concept08Subagents } from "./concepts/Concept08Subagents";
import { Concept09SystemPrompts } from "./concepts/Concept09SystemPrompts";
import { Concept10StructuredInterrupt } from "./concepts/Concept10StructuredInterrupt";
import { Concept11Skills } from "./concepts/Concept11Skills";
import { Concept12StreamingInput } from "./concepts/Concept12StreamingInput";
import { Concept13McpServers } from "./concepts/Concept13McpServers";
import { Concept14ThinkingEffortModels } from "./concepts/Concept14ThinkingEffortModels";
import { Concept15CostUsage } from "./concepts/Concept15CostUsage";
import { Concept16SettingsEnv } from "./concepts/Concept16SettingsEnv";
import { Concept17Checkpointing } from "./concepts/Concept17Checkpointing";
import { Concept18Sandbox } from "./concepts/Concept18Sandbox";
import { Concept19SessionManagement } from "./concepts/Concept19SessionManagement";
import { Concept20HooksInDepth } from "./concepts/Concept20HooksInDepth";
import { Concept21SlashCommands } from "./concepts/Concept21SlashCommands";
import { Concept22ClaudeMdMemory } from "./concepts/Concept22ClaudeMdMemory";
import { Concept23Plugins } from "./concepts/Concept23Plugins";
import { Concept24Harnesses } from "./concepts/Concept24Harnesses";
import { Concept25CompactionContext } from "./concepts/Concept25CompactionContext";
import { Concept26QueryControl } from "./concepts/Concept26QueryControl";
import { Concept27BackgroundTasks } from "./concepts/Concept27BackgroundTasks";
import { Concept28ErrorsRetries } from "./concepts/Concept28ErrorsRetries";
import { Concept29ImagesFiles } from "./concepts/Concept29ImagesFiles";
import { Concept30TodoTracking } from "./concepts/Concept30TodoTracking";
import { Concept31AskUserQuestion } from "./concepts/Concept31AskUserQuestion";
import { Concept32PlanMode } from "./concepts/Concept32PlanMode";

// Each new concept adds one entry here.
const concepts = [
  { id: 1, title: "query()", Component: Concept01Query },
  { id: 2, title: "Options", Component: Concept02Options },
  { id: 3, title: "Built-in tools", Component: Concept03Tools },
  { id: 4, title: "Permissions", Component: Concept04Permissions },
  { id: 5, title: "Custom tools", Component: Concept05CustomTools },
  { id: 6, title: "Sessions", Component: Concept06Sessions },
  { id: 7, title: "Hooks", Component: Concept07Hooks },
  { id: 8, title: "Subagents", Component: Concept08Subagents },
  { id: 9, title: "System prompts", Component: Concept09SystemPrompts },
  { id: 10, title: "Structured output & interrupt", Component: Concept10StructuredInterrupt },
  { id: 11, title: "Skills", Component: Concept11Skills },
  { id: 12, title: "Streaming input", Component: Concept12StreamingInput },
  { id: 13, title: "MCP servers", Component: Concept13McpServers },
  { id: 14, title: "Thinking, effort & models", Component: Concept14ThinkingEffortModels },
  { id: 15, title: "Cost & usage", Component: Concept15CostUsage },
  { id: 16, title: "Settings & env", Component: Concept16SettingsEnv },
  { id: 17, title: "Checkpointing & rewind", Component: Concept17Checkpointing },
  { id: 18, title: "Sandbox", Component: Concept18Sandbox },
  { id: 19, title: "Session management", Component: Concept19SessionManagement },
  { id: 20, title: "Hooks in depth", Component: Concept20HooksInDepth },
  { id: 21, title: "Slash commands", Component: Concept21SlashCommands },
  { id: 22, title: "CLAUDE.md & memory", Component: Concept22ClaudeMdMemory },
  { id: 23, title: "Plugins", Component: Concept23Plugins },
  { id: 24, title: "Harnesses", Component: Concept24Harnesses },
  { id: 25, title: "Compaction & context", Component: Concept25CompactionContext },
  { id: 26, title: "Query control methods", Component: Concept26QueryControl },
  { id: 27, title: "Background tasks", Component: Concept27BackgroundTasks },
  { id: 28, title: "Errors, retries & recovery", Component: Concept28ErrorsRetries },
  { id: 29, title: "Images & file input", Component: Concept29ImagesFiles },
  { id: 30, title: "Todo tracking", Component: Concept30TodoTracking },
  { id: 31, title: "AskUserQuestion", Component: Concept31AskUserQuestion },
  { id: 32, title: "Plan mode", Component: Concept32PlanMode },
];

export function App() {
  const [active, setActive] = useState(concepts[0].id);
  const Current = concepts.find((c) => c.id === active)!.Component;
  return (
    <main>
      <h1>Claude Agent SDK Lab</h1>
      <nav>
        {concepts.map((c) => (
          <button key={c.id} className={c.id === active ? "active" : ""} onClick={() => setActive(c.id)}>
            {c.id}. {c.title}
          </button>
        ))}
      </nav>
      <Current />
    </main>
  );
}
