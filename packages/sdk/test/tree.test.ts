import { describe, it, expect } from 'vitest'
import { resolveTree } from '../src/tree'
import type { SchemaInfo } from '../src/types'

const schema: SchemaInfo = {
  models: [
    { name: 'Organization', fields: [
      { name: 'id', type: 'String', isRequired: true, isId: true, hasDefault: true },
      { name: 'name', type: 'String', isRequired: true, isId: false, hasDefault: false },
    ]},
    { name: 'User', fields: [
      { name: 'id', type: 'String', isRequired: true, isId: true, hasDefault: true },
      { name: 'name', type: 'String', isRequired: true, isId: false, hasDefault: false },
      { name: 'email', type: 'String', isRequired: true, isId: false, hasDefault: false },
      { name: 'organizationId', type: 'String', isRequired: true, isId: false, hasDefault: false },
    ]},
    { name: 'Member', fields: [
      { name: 'id', type: 'String', isRequired: true, isId: true, hasDefault: true },
      { name: 'userId', type: 'String', isRequired: true, isId: false, hasDefault: false },
      { name: 'organizationId', type: 'String', isRequired: true, isId: false, hasDefault: false },
      { name: 'role', type: 'String', isRequired: true, isId: false, hasDefault: false },
    ]},
    { name: 'Application', fields: [
      { name: 'id', type: 'String', isRequired: true, isId: true, hasDefault: true },
      { name: 'name', type: 'String', isRequired: true, isId: false, hasDefault: false },
      { name: 'organizationId', type: 'String', isRequired: true, isId: false, hasDefault: false },
    ]},
    { name: 'AppVersion', fields: [
      { name: 'id', type: 'String', isRequired: true, isId: true, hasDefault: true },
      { name: 'name', type: 'String', isRequired: true, isId: false, hasDefault: false },
      { name: 'applicationId', type: 'String', isRequired: true, isId: false, hasDefault: false },
    ]},
  ],
  edges: [
    { from: 'User', to: 'Organization', localField: 'organizationId', foreignField: 'id', nullable: false },
    { from: 'Member', to: 'Organization', localField: 'organizationId', foreignField: 'id', nullable: false },
    { from: 'Member', to: 'User', localField: 'userId', foreignField: 'id', nullable: false },
    { from: 'Application', to: 'Organization', localField: 'organizationId', foreignField: 'id', nullable: false },
    { from: 'AppVersion', to: 'Application', localField: 'applicationId', foreignField: 'id', nullable: false },
  ],
  relations: [
    { parentModel: 'Organization', childModel: 'User', parentField: 'users', childField: 'organizationId' },
    { parentModel: 'Organization', childModel: 'Member', parentField: 'members', childField: 'organizationId' },
    { parentModel: 'Organization', childModel: 'Application', parentField: 'applications', childField: 'organizationId' },
    { parentModel: 'Member', childModel: 'User', parentField: 'user', childField: 'userId' },
    { parentModel: 'Application', childModel: 'AppVersion', parentField: 'versions', childField: 'applicationId' },
  ],
  scopeField: 'organizationId',
}

describe('resolveTree', () => {
  it('resolves a basic tree into ordered ops', () => {
    const result = resolveTree(
      {
        Organization: [{
          name: 'Acme',
          users: [
            { name: 'Alice', email: 'alice@test.com' },
            { name: 'Bob', email: 'bob@test.com' },
          ],
        }],
      },
      schema,
      'run-1',
    )

    expect(result.ops).toHaveLength(3) // 1 org + 2 users
    expect(result.ops[0]!.model).toBe('Organization')
    expect(result.ops[1]!.model).toBe('User')
    expect(result.ops[2]!.model).toBe('User')

    // Users should reference org's temp ID
    const orgTempId = result.ops[0]!.tempId
    expect(result.ops[1]!.fields.organizationId).toBe(orgTempId)
    expect(result.ops[2]!.fields.organizationId).toBe(orgTempId)
  })

  it('resolves deep nesting (org → app → version)', () => {
    const result = resolveTree(
      {
        Organization: [{
          name: 'Acme',
          applications: [{
            name: 'Web App',
            versions: [
              { name: 'v1.0' },
              { name: 'v2.0' },
            ],
          }],
        }],
      },
      schema,
      'run-2',
    )

    expect(result.ops).toHaveLength(4) // org + app + 2 versions
    const appTempId = result.ops[1]!.tempId
    expect(result.ops[2]!.fields.applicationId).toBe(appTempId)
    expect(result.ops[3]!.fields.applicationId).toBe(appTempId)
  })

  it('distributes children across different parents', () => {
    const result = resolveTree(
      {
        Organization: [{
          name: 'Acme',
          applications: [
            { name: 'Web', versions: [{ name: 'v1.0' }] },
            { name: 'Mobile', versions: [{ name: 'v2.0' }, { name: 'v3.0' }] },
          ],
        }],
      },
      schema,
      'run-3',
    )

    // org, web, v1.0, mobile, v2.0, v3.0
    expect(result.ops).toHaveLength(6)
    const webTempId = result.ops[1]!.tempId
    const mobileTempId = result.ops[3]!.tempId
    expect(webTempId).not.toBe(mobileTempId)

    expect(result.ops[2]!.fields.applicationId).toBe(webTempId)  // v1.0 → web
    expect(result.ops[4]!.fields.applicationId).toBe(mobileTempId) // v2.0 → mobile
    expect(result.ops[5]!.fields.applicationId).toBe(mobileTempId) // v3.0 → mobile
  })

  it('resolves _alias / _ref across branches', () => {
    const result = resolveTree(
      {
        Organization: [{
          name: 'Acme',
          applications: [{
            name: 'Web',
            versions: [{ _alias: 'v1', name: 'v1.0' }],
          }],
          // Member needs a user — nest under member
          members: [{
            role: 'owner',
            user: [{ name: 'Alice', email: 'alice@test.com' }],
          }],
        }],
      },
      schema,
      'run-4',
    )

    // org, app, v1.0, member, user
    expect(result.ops.length).toBeGreaterThanOrEqual(5)

    // v1 alias should map to the version's temp ID
    const versionOp = result.ops.find((o) => o.model === 'AppVersion')!
    expect(result.aliases.get('v1')).toBe(versionOp.tempId)
  })

  it('solves the member-user distribution problem', () => {
    // This is the key scenario: 3 members each with their own user
    const result = resolveTree(
      {
        Organization: [{
          name: 'Acme',
          members: [
            { role: 'owner', user: [{ name: 'Alice', email: 'alice@test.com' }] },
            { role: 'admin', user: [{ name: 'Bob', email: 'bob@test.com' }] },
            { role: 'viewer', user: [{ name: 'Carol', email: 'carol@test.com' }] },
          ],
        }],
      },
      schema,
      'run-5',
    )

    const memberOps = result.ops.filter((o) => o.model === 'Member')
    const userOps = result.ops.filter((o) => o.model === 'User')

    expect(memberOps).toHaveLength(3)
    expect(userOps).toHaveLength(3)

    // Each member should reference a DIFFERENT user
    const userTempIds = userOps.map((o) => o.tempId)
    const memberUserIds = memberOps.map((o) => o.fields.userId)

    // All different
    expect(new Set(userTempIds).size).toBe(3)
    expect(new Set(memberUserIds).size).toBe(3)

    // Each member's userId matches its nested user's tempId
    // Order: org, member0, user0, member1, user1, member2, user2
    for (let i = 0; i < 3; i++) {
      expect(memberUserIds[i]).toBe(userTempIds[i])
    }
  })

  it('resolves bulk nodes with _count', () => {
    const result = resolveTree(
      {
        Organization: [{
          name: 'Acme',
          applications: [{
            name: 'App',
            versions: { _count: 100, _batch: true, name: 'v{{index1}}' },
          }],
        }],
      },
      schema,
      'run-6',
    )

    const versionOps = result.ops.filter((o) => o.model === 'AppVersion')
    expect(versionOps).toHaveLength(100)
    expect(versionOps[0]!.batch).toBe(true)
    expect(versionOps[0]!.fields.name).toBe('v1')
    expect(versionOps[99]!.fields.name).toBe('v100')

    // All should point to the same parent app
    const appTempId = result.ops.find((o) => o.model === 'Application')!.tempId
    expect(versionOps[0]!.fields.applicationId).toBe(appTempId)
    expect(versionOps[99]!.fields.applicationId).toBe(appTempId)
  })

  it('resolves {{testRunId}} in templates', () => {
    const result = resolveTree(
      { Organization: [{ name: 'Org [{{testRunId}}]' }] },
      schema,
      'xyz-123',
    )
    expect(result.ops[0]!.fields.name).toBe('Org [xyz-123]')
  })

  it('throws on missing _ref', () => {
    expect(() =>
      resolveTree(
        {
          Organization: [{
            name: 'Acme',
            applications: [{
              name: 'App',
              versions: [{ name: 'v1', applicationId: { _ref: 'nope' } }],
            }],
          }],
        },
        schema,
        'run',
      ),
    ).toThrow('_ref "nope" not found')
  })
})
