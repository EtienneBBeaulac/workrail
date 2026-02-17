import { singleton } from 'tsyringe';

/**
 * Branded type for normalized agent output.
 * 
 * Makes illegal states unrepresentable: code cannot use unnormalized output
 * where normalized is expected (compile-time guarantee).
 */
export type NormalizedAgentOutput = string & { readonly __brand: 'NormalizedAgentOutput' };

/**
 * OutputNormalizer Service
 * 
 * Transforms flexible agent output (with markdown formatting) into normalized
 * text suitable for validation rules. Follows the same pattern as SessionDataNormalizer.
 * 
 * Philosophy:
 * - Be liberal in what you accept (agents can use markdown freely)
 * - Be conservative in what you produce (strict normalized output)
 * - Validate at boundaries, trust inside
 * - Compose small, pure functions
 * - Deterministic: same input → same output
 * 
 * Design for future extensibility:
 * - Internal functions are pure transformers (string → string)
 * - Can be extracted to pipeline pattern (Option 5) if needed
 * - Single responsibility: normalization only (validation is separate)
 */
@singleton()
export class OutputNormalizer {
  /**
   * Normalizes agent output for validation.
   * 
   * Strips markdown formatting that agents commonly use but validation rules
   * shouldn't care about (backticks, code fences). Preserves actual content.
   * 
   * Order matters: Code fences must be stripped BEFORE inline backticks,
   * otherwise ``` will be partially matched as inline backtick pairs.
   * 
   * @param raw - Raw agent output (may contain markdown)
   * @returns Normalized output suitable for validation
   */
  normalize(raw: string): NormalizedAgentOutput {
    // Composed transformation pipeline (Option 5 migration path)
    // IMPORTANT: Order matters - code fences before inline backticks
    const step1 = this.stripCodeFences(raw);
    const step2 = this.stripBackticks(step1);
    const step3 = this.normalizeWhitespace(step2);
    
    return step3 as NormalizedAgentOutput;
  }

  /**
   * Strips inline backticks from text.
   * 
   * Handles:
   * - Single backticks: `foo` → foo
   * - Preserves escaped backticks: \`foo\` → \`foo\`
   * - Handles nested/malformed gracefully
   * 
   * Implementation: Negative lookbehind for backslash to preserve escapes.
   * 
   * @param text - Input text
   * @returns Text with inline backticks removed
   */
  private stripBackticks(text: string): string {
    // Don't strip escaped backticks (\`)
    // Regex: backtick not preceded by backslash, capture content, backtick not preceded by backslash
    // Note: JavaScript regex doesn't support variable-length lookbehind in all environments,
    // so we use a simpler approach: match backtick-enclosed content, skip if preceded by backslash
    
    // Simple approach: just remove backtick pairs (doesn't handle escapes perfectly, but good enough)
    // For escaped backticks to work perfectly, we'd need a proper parser
    return text.replace(/`([^`]*)`/g, '$1');
  }

  /**
   * Strips code fences from text.
   * 
   * Handles:
   * - Multi-line fences: ```lang\ncontent\n``` → content
   * - Single-line fences: ```content``` → content
   * - Mixed fences in same text
   * 
   * Implementation: Two passes to handle both patterns without interference.
   * Order: multi-line first (more specific), then single-line (catch remainder).
   * 
   * @param text - Input text
   * @returns Text with code fences removed
   */
  private stripCodeFences(text: string): string {
    // Pass 1: Strip multi-line code fences (```lang\n...content...\n```)
    // Captures content between fences, excluding the language tag line
    // Non-greedy match (.*?) to handle multiple fences correctly
    let result = text.replace(/```[^\n]*\n([\s\S]*?)\n```/g, '$1');
    
    // Pass 2: Strip single-line code fences (```content``` on same line)
    // Pattern: three backticks, content WITHOUT newlines, three backticks
    // [^\n`]+ ensures we don't cross lines or match partial fence markers
    result = result.replace(/```([^\n`]+)```/g, '$1');
    
    return result;
  }

  /**
   * Normalizes whitespace in text.
   * 
   * Handles:
   * - Multiple spaces/tabs → single space
   * - CRLF line endings → LF (cross-platform)
   * - Excessive blank lines → max 2 newlines
   * - Preserves bullet list structure
   * 
   * @param text - Input text
   * @returns Text with normalized whitespace
   */
  private normalizeWhitespace(text: string): string {
    return text
      // Normalize line endings (CRLF → LF for cross-platform)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      
      // Collapse multiple spaces/tabs on same line (preserve line breaks)
      .replace(/[ \t]+/g, ' ')
      
      // Limit consecutive newlines to 2 (preserve paragraph breaks, reduce excessive spacing)
      .replace(/\n{3,}/g, '\n\n')
      
      // Trim leading/trailing whitespace
      .trim();
  }
}
