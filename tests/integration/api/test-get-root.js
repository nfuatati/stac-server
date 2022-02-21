const test = require('ava')
const { apiClient } = require('../helpers/api-client')

test('/', async (t) => {
  const response = await apiClient.get('')
  t.is(response.links.length, 8)
})

test('/ conformsTo', async (t) => {
  const response = await apiClient.get('')
  t.is(response.conformsTo.length, 13)
})
