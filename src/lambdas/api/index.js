// @ts-check

/**
 * To Do
 *
 * - `invokePreHook` and `invokePostHook` are very similar. They should be DRY'd up.
 */

const { z } = require('zod')
const serverless = require('serverless-http')
const { Lambda } = require('aws-sdk')
const { app } = require('./app')
const {
  APIGatewayProxyResultSchema,
  PreHookResultSchema,
  PostHookResultSchema,
  LambdaErrorSchema, // eslint-disable-line no-unused-vars
  APIGatewayProxyEventSchema
} = require('./types')

/**
 * @typedef {import('aws-lambda').APIGatewayProxyEvent} APIGatewayProxyEvent
 * @typedef {import('aws-lambda').APIGatewayProxyResult} APIGatewayProxyResult
 * @typedef {import('aws-lambda').Context} Context
 * @typedef {z.infer<typeof LambdaErrorSchema>} LambdaError
 */

/** @type {APIGatewayProxyResult} */
const internalServerError = Object.freeze({
  statusCode: 500,
  headers: {
    'content-type': 'text/plain'
  },
  body: 'Internal Server Error'
})

/**
 * @param {unknown} data
 * @param {unknown} error
 * @returns {void}
 */
const logZodParseError = (data, error) => {
  let errorObj
  if (error instanceof z.ZodError) {
    errorObj = { data, issues: error.issues }
  } else if (error instanceof Error) {
    errorObj = {
      data,
      error: {
        name: error.name,
        message: error.message
      }
    }
  } else {
    errorObj = { data, error }
  }

  console.error(JSON.stringify(errorObj, undefined, 2))
}

/**
 * @param {Lambda} lambda
 * @param {string} preHook
 * @param {APIGatewayProxyEvent} payload
 * @returns {Promise<APIGatewayProxyEvent|APIGatewayProxyResult>}
 */
const invokePreHook = async (lambda, preHook, payload) => {
  /** @type {Lambda.InvocationResponse} */
  let invocationResponse
  try {
    invocationResponse = await lambda.invoke({
      FunctionName: preHook,
      Payload: JSON.stringify(payload)
    }).promise()
  } catch (error) {
    console.error('Failed to invoke pre-hook lambda:', error)
    return internalServerError
  }

  // I've never seen this happen but, according to the TypeScript type definitions
  // provided by AWS, `Lambda.InvocationResponse.Payload` could be `undefined`.
  if (invocationResponse.Payload === undefined) {
    console.error('Undefined Payload returned from pre-hook lambda')
    return internalServerError
  }

  const rawHookResult = JSON.parse(invocationResponse.Payload.toString())

  /** @type {APIGatewayProxyEvent|APIGatewayProxyResult|LambdaError} */
  let hookResult
  try {
    // @ts-expect-error https://github.com/colinhacks/zod/issues/980
    hookResult = PreHookResultSchema.parse(rawHookResult)
  } catch (error) {
    console.error('Failed to parse response from pre-hook')
    logZodParseError(rawHookResult, error)
    return internalServerError
  }

  if ('errorType' in hookResult) {
    console.error('Pre-hook failed:', hookResult.trace.join('\n'))
    return internalServerError
  }

  return hookResult
}

/**
 * @param {Lambda} lambda
 * @param {string} postHook
 * @param {APIGatewayProxyResult} payload
 * @returns {Promise<APIGatewayProxyResult>}
 */
const invokePostHook = async (lambda, postHook, payload) => {
  /** @type {Lambda.InvocationResponse} */
  let invocationResponse
  try {
    invocationResponse = await lambda.invoke({
      FunctionName: postHook,
      Payload: JSON.stringify(payload)
    }).promise()
  } catch (error) {
    console.error('Failed to invoke post-hook lambda:', error)
    return internalServerError
  }

  // I've never seen this happen but, according to the TypeScript type definitions
  // provided by AWS, `Lambda.InvocationResponse.Payload` could be `undefined`.
  if (invocationResponse.Payload === undefined) {
    console.error('Undefined Payload returned from post-hook lambda')
    return internalServerError
  }

  const rawHookResult = JSON.parse(invocationResponse.Payload.toString())

  /** @type {APIGatewayProxyResult|LambdaError} */
  let hookResult
  try {
    hookResult = PostHookResultSchema.parse(rawHookResult)
  } catch (error) {
    console.error('Failed to parse response from post-hook')
    logZodParseError(rawHookResult, error)
    return internalServerError
  }

  if ('errorType' in hookResult) {
    console.error('Post hook failed:', hookResult.trace.join('\n'))
    return internalServerError
  }

  return hookResult
}

/**
 * @param {APIGatewayProxyEvent} event
 * @param {Context} context
 * @returns {Promise<APIGatewayProxyResult>}
 */
const callServerlessApp = async (event, context) => {
  const result = await serverless(app)(event, context)

  try {
    return APIGatewayProxyResultSchema.parse(result)
  } catch (error) {
    console.error('Failed to parse response from serverless app')
    logZodParseError(result, error)
    return internalServerError
  }
}

/**
 *
 * @param {unknown} rawEvent
 * @returns {APIGatewayProxyEvent}
 */
const parseEvent = (rawEvent) => {
  const event = APIGatewayProxyEventSchema.parse(rawEvent)

  /** @type {string} */
  let validPath
  if (event.pathParameters === null) {
    validPath = '/'
  } else if ('proxy' in event.pathParameters) {
    validPath = `/${event.pathParameters['proxy']}`
  } else {
    throw new Error('Unable to determine path from event')
  }

  // @ts-expect-error https://github.com/colinhacks/zod/issues/980
  return { ...event, path: validPath }
}

/**
 * @param {APIGatewayProxyEvent} event
 * @param {Context} context
 * @returns {Promise<APIGatewayProxyResult>}
 */
const handler = async (event, context) => {
  if (!process.env['AWS_REGION']) {
    console.error('AWS_REGION not set')
    return internalServerError
  }

  const lambda = new Lambda({ region: process.env['AWS_REGION'] })

  /** @type {APIGatewayProxyEvent} */
  let parsedEvent
  try {
    parsedEvent = parseEvent(event)
  } catch (error) {
    logZodParseError(event, error)
    return internalServerError
  }

  /** @type {APIGatewayProxyEvent|APIGatewayProxyResult} */
  const serverlessAppEvent = process.env['PRE_HOOK']
    ? await invokePreHook(lambda, process.env['PRE_HOOK'], parsedEvent)
    : parsedEvent

  if ('statusCode' in serverlessAppEvent) return serverlessAppEvent

  const serverlessAppResult = await callServerlessApp(serverlessAppEvent, context)

  return process.env['POST_HOOK']
    ? await invokePostHook(lambda, process.env['POST_HOOK'], serverlessAppResult)
    : serverlessAppResult
}

module.exports = { handler }
