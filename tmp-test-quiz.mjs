import('./lms-project/lambdas/quiz/index.mjs').then(m =>
  m.handler({ httpMethod: 'GET', pathParameters: { id: '17a9db2d-c9be-48db-a6d7-5b5aabd97741' } })
).then(r => {
  console.log(JSON.stringify(r, null, 2));
}).catch(e => {
  console.error('ERROR', e);
  process.exit(1);
});