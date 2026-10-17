// Default sizes for shapes, in one place. The zod schema uses them on the server; shared/mechanism.ts applies them
// too, so the widget can build models straight from a short description (for example its standalone demo).

export const SHAPE_DEFAULTS = {
  gear: { teeth: 20, module: 2, thickness: 6 },
  pulley: { diameter: 40, width: 10 },
  rack: { length: 120, module: 2, height: 12, thickness: 6 },
} as const;

/** Fill in missing fields of gear, pulley and rack shapes. Other shapes are returned unchanged. */
export function withShapeDefaults<S extends { type: string }>(shape: S): S {
  const defaults = (SHAPE_DEFAULTS as Record<string, object>)[shape.type];
  return defaults ? ({ ...defaults, ...shape } as S) : shape;
}
