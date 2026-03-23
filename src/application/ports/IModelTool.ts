/**
 * Minimal port for LLM tools invoked directly by the orchestrator.
 *
 * @template TArgs - The arguments shape expected by the tool's invoke method
 */
export interface IModelTool<TArgs extends Record<string, unknown>> {
    invoke(args: TArgs): Promise<unknown>;
}
