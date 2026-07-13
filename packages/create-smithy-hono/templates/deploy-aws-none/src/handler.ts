/**
 * AWS Lambda entry (hono/aws-lambda). The app is served under `/api`, backed by a
 * DynamoDB DataStore. CloudFront (provisioned by `@smithy-hono/deploy-aws`) routes
 * `/api/*` to this Lambda and everything else to the S3 SPA origin, same-origin.
 *
 * The adapter never imports the AWS SDK (ARCH-01): it speaks to DynamoDB through a
 * structural `DynamoSendLike` that maps the port's tagged command inputs
 * (`{ __command: 'Put'|'Get'|'Update'|'Delete'|'Query', ...}`) onto the real
 * DocumentClient commands, supplied here.
 */
import { handle } from 'hono/aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  createDynamoDataStore,
  createDynamoDataPort,
  type DynamoSendLike,
} from '@smithy-hono/adapter-aws'
import { createApp } from './createApp'
import type { TaskData } from './generated/task.gen'

const TABLE = process.env.TABLE ?? '{{APP_SLUG}}-data'

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const COMMANDS = {
  Put: PutCommand,
  Get: GetCommand,
  Update: UpdateCommand,
  Delete: DeleteCommand,
  Query: QueryCommand,
} as const

const sendLike: DynamoSendLike = {
  send(command) {
    const { __command, ...input } = command as { __command: keyof typeof COMMANDS } & Record<
      string,
      unknown
    >
    const Command = COMMANDS[__command]
    return doc.send(new Command(input as never)) as Promise<
      { Item?: Record<string, unknown> } & Record<string, unknown>
    >
  },
}

const store = createDynamoDataStore<TaskData>(createDynamoDataPort(sendLike, TABLE), { table: TABLE })
const { app } = createApp({ store, basePath: '/api' })

export const handler = handle(app)
