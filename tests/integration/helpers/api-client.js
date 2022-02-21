const got = require('got')

const apiClient = got.extend({
  prefixUrl: 'http://localhost:3000/dev/',
  headers: {
    'X-Forwarded-Proto': 'http'
  },
  responseType: 'json',
  resolveBodyOnly: true
})

module.exports = { apiClient }
