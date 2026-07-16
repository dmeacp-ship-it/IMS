'use strict';

// Local dev entry point. On Vercel the Express app in api/index.js is invoked
// directly as a serverless function, so this file is not used in production.
require('dotenv/config');

const app = require('./api/index');
const port = process.env.PORT || 3000;

app.listen(port, function () {
  console.log('Virgo ACP IMS running on http://localhost:' + port);
});
