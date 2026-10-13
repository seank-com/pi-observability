import { rehydrateToolIntentHistory } from "./intent-history.ts";
export const TOOL_INTENT_FIELD = "intent";
export const TOOL_INTENT_GUIDANCE = "Every tool call has two parts: its normal execution arguments and an intent describing the purpose of the tool call. Intent is audit metadata and must be included on every call, including parallel calls and retries. The intent should be a single sentence plainly describing what the tool call accomplishes. Do not include argument values, file paths, or other parameters.";
export const TOOL_INTENT_EXAMPLES = [
    "These examples illustrate tool names and arguments. Make actual calls through the native tool-call interface; do not write them as text.",
    'Tool: read\nArguments: {"path":"README.md","intent":"Understand the project setup instructions."}',
    'Tool: bash\nArguments: {"command":"git status --short","intent":"Check for uncommitted changes before editing."}',
].join("\n\n");
export const TOOL_INTENT_INSTRUCTIONS = `${TOOL_INTENT_GUIDANCE}\n\n${TOOL_INTENT_EXAMPLES}`;
function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Transform only request-local declarations; never change executable tool schemas. */
export function instrumentIntentContext(source: readonly unknown[], branchEntries: readonly unknown[]) {
    // Pi already clones its transcript; own a separate copy so any failure is atomic
    // even with another caller, and no partial decoration escapes a caught exception.
    const messages: Record<string, unknown>[] = structuredClone(source).map(message => {
        if (!record(message))
            throw new Error("Unsupported context message");
        return message;
    });
    const head = messages[0];
    if (!head || head.role !== "system")
        throw new Error("Context needs a leading system message");
    const activeNames = new Set<string>();
    for (const message of messages) {
        if (message.role !== "system")
            continue;
        if (message.toolsRemoved !== undefined) {
            if (!Array.isArray(message.toolsRemoved))
                throw new Error("Unsupported removed tools");
            for (const tool of message.toolsRemoved) {
                if (!record(tool) || typeof tool.name !== "string")
                    throw new Error("Unsupported removed tool");
                activeNames.delete(tool.name);
            }
        }
        if (message.toolsAdded === undefined)
            continue;
        if (!Array.isArray(message.toolsAdded))
            throw new Error("Unsupported tool declarations");
        for (const tool of message.toolsAdded) {
            if (!record(tool) || typeof tool.name !== "string" || !tool.name || tool.name.length > 256)
                throw new Error("Unsupported tool declaration");
            const sampling = tool.constrainedSampling;
            if (sampling !== undefined && sampling !== false && (!record(sampling) || sampling.type !== "json_schema" || (sampling.strict !== "prefer" && sampling.strict !== "require")))
                throw new Error("Unsupported tool constrained sampling");
            const schema = tool.parameters;
            if (!record(schema) || schema.type !== "object" || (schema.properties !== undefined && !record(schema.properties)) || (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(field => typeof field === "string"))))
                throw new Error("Tool must have an object JSON schema");
            const properties = (schema.properties ?? {}) as Record<string, unknown>;
            // No marker-based exception: a tool-owned intent is always a collision.
            if (Object.hasOwn(properties, TOOL_INTENT_FIELD))
                throw new Error("Tool uses reserved property intent");
            tool.parameters = {
                ...schema,
                properties: {
                    ...properties,
                    intent: { type: "string", minLength: 1, maxLength: 1000, description: TOOL_INTENT_GUIDANCE },
                },
                required: [...new Set([...(schema.required as string[] ?? []), TOOL_INTENT_FIELD])],
            };
            activeNames.add(tool.name);
        }
    }
    // Preserve structured prompt sections and content blocks, including later deltas.
    if (typeof head.content === "string")
        head.content = `${head.content}\n\n${TOOL_INTENT_INSTRUCTIONS}`;
    else if (Array.isArray(head.content))
        head.content = [...head.content, { type: "text", text: TOOL_INTENT_INSTRUCTIONS }];
    else
        throw new Error("Unsupported system content");
    const history = rehydrateToolIntentHistory(messages, branchEntries);
    return { messages, activeNames, history };
}
