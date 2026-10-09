import { SERVICE_NAME } from './service.js';
import { trace, SpanKind, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';

const tracer: Tracer = trace.getTracer(SERVICE_NAME);

type SpanAttributeValue = string | number | boolean;

/**
 * Start a new span. Caller is responsible for calling span.end().
 */
export function startSpan(
  name: string,
  attributes?: Record<string, SpanAttributeValue>,
  kind: SpanKind = SpanKind.INTERNAL
): Span {
  return tracer.startSpan(name, { kind, attributes });
}

/**
 * Run an async function inside a new span.
 * Span is automatically ended and errors are recorded.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, SpanAttributeValue>,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL
): Promise<T> {
  return tracer.startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Get the current active span for adding attributes without creating a new one.
 */
export function getActiveSpan(): Span | undefined {
  return trace.getActiveSpan();
}

// ── @Traced decorator ─────────────────────────────────────
//
// Usage:
//   @Traced('credit.reserve', { 'credit.operation': 'reserve' })
//   async reserveCredits(tenantId: string, ...) { ... }
//
// Inside the decorated method, call `Traced.getSpan()` to add
// dynamic attributes:
//   Traced.getSpan()?.setAttribute('credit.amount', 500);
//
// The decorator automatically:
//  - creates an active span wrapping the method call
//  - records exceptions and sets ERROR status on throw
//  - ends the span in a finally block

/** WeakMap storing the active span for the current method invocation. */
const activeSpanMap = new WeakMap<object, Span>();

interface TracedOptions {
  /** Static attributes set when the span is created. */
  attributes?: Record<string, SpanAttributeValue>;
  /** Span kind (default INTERNAL). */
  kind?: SpanKind;
  /**
   * Extract dynamic attributes from the method arguments.
   * Receives the same args as the method, returns attributes to set on the span.
   */
  attrs?: (...args: any[]) => Record<string, SpanAttributeValue>;
}

/**
 * TC39 stage-3 method decorator that wraps an async method in an OTel span.
 *
 * @param spanName  - Name of the span (e.g. 'credit.reserve')
 * @param opts      - Optional static attributes, kind, or dynamic attribute extractor
 */
export function Traced(spanName: string, opts: TracedOptions = {}) {
  return function <T extends (...args: any[]) => Promise<any>>(
    originalMethod: T,
    context: ClassMethodDecoratorContext,
  ): T {
    const wrapped = function (this: any, ...args: any[]): Promise<any> {
      const staticAttrs = opts.attributes ?? {};
      const dynamicAttrs = opts.attrs ? opts.attrs(...args) : {};
      const allAttrs = { ...staticAttrs, ...dynamicAttrs };
      const kind = opts.kind ?? SpanKind.INTERNAL;

      return tracer.startActiveSpan(spanName, { kind, attributes: allAttrs }, async (span) => {
        activeSpanMap.set(this, span);
        try {
          const result = await originalMethod.call(this, ...args);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          throw error;
        } finally {
          activeSpanMap.delete(this);
          span.end();
        }
      });
    };

    return wrapped as T;
  };
}

/**
 * Retrieve the active span created by @Traced for the current method invocation.
 * Call from inside a @Traced method to set dynamic attributes.
 */
Traced.getSpan = function (instance: object): Span | undefined {
  return activeSpanMap.get(instance);
};

export { SpanKind, SpanStatusCode };
