const http = require('http');

// Test configuration
const tests = [
  { host: 'ai.jasonmcaffee.com', expected: 'NestJS (8081)' },
  { host: 'jasonmcaffee.com', expected: 'NextJS (8080)' },
  { host: 'blog.jasonmcaffee.com', expected: 'NextJS (8080)' },
  { host: 'api.jasonmcaffee.com', expected: 'NextJS (8080)' },
  { host: 'unknown.com', expected: 'NextJS (8080) - fallback' }
];

console.log('🧪 Testing Proxy Service...\n');

tests.forEach((test, index) => {
  const options = {
    hostname: 'localhost',
    port: 80,
    path: '/',
    method: 'GET',
    headers: {
      'Host': test.host,
      'User-Agent': 'Test-Script/1.0'
    }
  };

  const req = http.request(options, (res) => {
    console.log(`✅ Test ${index + 1}: ${test.host}`);
    console.log(`   Expected: ${test.expected}`);
    console.log(`   Status: ${res.statusCode}`);
    console.log(`   Headers: ${JSON.stringify(res.headers, null, 2)}`);
    console.log('');
  });

  req.on('error', (err) => {
    console.log(`❌ Test ${index + 1}: ${test.host}`);
    console.log(`   Error: ${err.message}`);
    console.log('');
  });

  req.end();
});

console.log('📋 Test Summary:');
console.log('- ai.jasonmcaffee.com should route to localhost:8081 (NestJS)');
console.log('- All other *.jasonmcaffee.com should route to localhost:8080 (NextJS)');
console.log('- Unknown domains should fallback to NextJS target');
console.log('\n💡 Make sure your proxy service is running on port 80');
console.log('💡 Make sure your backend services are running on ports 8080 and 8081');

