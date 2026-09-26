/**
 * Real D2 example sources: a decision flow, a SQL-style ERD, and a grouped
 * cloud architecture.
 * They are compiled by the real D2 layout engines (dagre/ELK), never by a
 * hand-written parser, and their measured outputs live in `fixtures/`.
 */

/** Small flow with a decision diamond and a revise branch. */
export const FLOW_D2_EXAMPLE = `direction: right
start: Start {shape: oval}
check: Approved? {shape: diamond}
ship: Ship it
fix: Fix issues
start -> check: submit
check -> ship: yes
check -> fix: no
fix -> check: revise
`;

/** SQL-style ERD: tables with typed fields, constraints and relationships. */
export const ERD_D2_EXAMPLE = `users: {
  shape: sql_table
  id: int {constraint: primary_key}
  name: varchar
  email: varchar {constraint: unique}
}
orders: {
  shape: sql_table
  id: int {constraint: primary_key}
  user_id: int {constraint: foreign_key}
  total: decimal
}
users.id <-> orders.user_id: places
`;

/** Cloud architecture: grouped services plus database and cache. */
export const CLOUD_D2_EXAMPLE = `direction: down
lb: Load balancer
api: API
db: Postgres {shape: cylinder}
cache: Redis {shape: stored_data}
infra: VPC {
  web: Web
  worker: Worker
  web -> worker: queue
}
lb -> api
api -> db: reads/writes
api -> cache
`;
