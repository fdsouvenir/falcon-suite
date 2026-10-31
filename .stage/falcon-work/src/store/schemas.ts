import { Type } from 'typebox';

// Bounded input pieces shared by the commands.
export const Id = Type.String({ minLength: 1, maxLength: 128 });
export const Title = Type.String({ minLength: 1, maxLength: 240 });
export const Text = Type.String({ minLength: 1, maxLength: 12000 });
export const Short = Type.String({ minLength: 1, maxLength: 2000 });
export const Reason = Type.String({ minLength: 1, maxLength: 1000 });
export const When = Type.String({ minLength: 10, maxLength: 64 });
export const Who = Type.String({ pattern: '^(person|agent):[^\\s]+$', maxLength: 160 });
export const Session = Type.String({ minLength: 1, maxLength: 256 });
export const Confidence = Type.Union([
	Type.Literal('tentative'),
	Type.Literal('supported'),
	Type.Literal('confirmed')
]);
export const Source = Type.Object(
	{
		ref: Type.String({ minLength: 1, maxLength: 4096 }),
		kind: Type.Optional(Type.String({ maxLength: 40 })),
		label: Type.Optional(Type.String({ maxLength: 1000 }))
	},
	{ additionalProperties: false }
);
export const Sources = Type.Array(Source, { minItems: 1, maxItems: 50 });
export const Target = Type.Object(
	{
		kind: Type.Union([
			Type.Literal('objective'),
			Type.Literal('project'),
			Type.Literal('milestone'),
			Type.Literal('task')
		]),
		id: Id
	},
	{ additionalProperties: false }
);
export const Empty = Type.Object({}, { additionalProperties: false });
export const obj = <P extends Record<string, any>>(props: P) =>
	Type.Object(props, { additionalProperties: false });
export const opt = Type.Optional;

/** A Task inside a plan: `key` names it so other Tasks in the same plan can depend on it. */
export const PlanTask = Type.Object(
	{
		key: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		title: Title,
		description: Text,
		done_when: Text,
		depends_on: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 50 })
		),
		agent: Type.Optional(Who),
		plan: Type.Optional(Text)
	},
	{ additionalProperties: false }
);
export const PlanMilestone = Type.Object(
	{
		title: Title,
		success_condition: Text,
		tasks: Type.Optional(Type.Array(PlanTask, { maxItems: 100 }))
	},
	{ additionalProperties: false }
);
