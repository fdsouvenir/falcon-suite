// What the `read` operation returns for each page: the store's projections, as plain JSON.
import type { Views, Entry } from '../store/views.js';

export type { Card, DoneRow, Entry, NeedsYouItem, SessionRef } from '../store/views.js';
export type ItemRef = NonNullable<Entry['item']>;
export type ItemKind = ItemRef['kind'];
export type HomePage = ReturnType<Views['home']> & { owner?: string };
export type ProjectPage = NonNullable<ReturnType<Views['project']>>;
export type TaskPage = NonNullable<ReturnType<Views['task']>>;
export type JobPage = NonNullable<ReturnType<Views['job']>>;
export type TaskLine = ProjectPage['other_tasks'][number];
export type SearchHit = ReturnType<Views['search']>[number];
