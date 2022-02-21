const test = require('ava')
const { apiClient } = require('../helpers/api-client')

test('/collections', async (t) => {
  const response = await apiClient.get('collections')

  t.is(response.collections.length, 2)
  t.is(response.context.returned, 2)
})
