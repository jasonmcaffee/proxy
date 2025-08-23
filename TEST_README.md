# WebSocket Proxy Gateway Test Suite

This test suite provides comprehensive testing for the WebSocket proxy gateway, ensuring that all namespaces are properly intercepted and forwarded by the proxy gateway.

## 🎯 Test Coverage

The test suite covers the following areas:

### 1. Unit Tests (`proxy.gateway.spec.ts`)
- **Gateway Configuration**: WebSocket gateway setup, CORS, path configuration
- **Backend Health Check**: Connection validation, error handling, environment variable usage
- **Connection Handling**: Client connections, backend connections, error scenarios
- **Message Forwarding**: Event forwarding, queuing, system event filtering
- **Disconnection Handling**: Clean disconnection, resource cleanup
- **Namespace Interception**: All namespace events, multiple arguments, complex data
- **Error Handling**: Timeouts, malformed URLs, connection failures
- **Performance & Scalability**: Multiple connections, rapid connect/disconnect cycles

### 2. End-to-End Tests (`proxy.gateway.e2e.spec.ts`)
- **Real WebSocket Connections**: Actual Socket.IO connections through the proxy
- **Message Forwarding**: End-to-end message transmission and echo testing
- **Multiple Client Handling**: Independent client connections and message isolation
- **Complex Data Structures**: Objects, arrays, nested data transmission
- **Rapid Message Sequences**: High-frequency message handling
- **Custom Namespace Events**: Various namespace patterns and event types
- **Connection Lifecycle**: Disconnection, reconnection, and recovery
- **Binary Data**: Buffer and binary data transmission
- **Room-based Messaging**: Socket.IO room functionality
- **Load Testing**: Concurrent connections and performance under load

### 3. Namespace Interception Tests
The proxy gateway is designed to intercept **ALL** possible WebSocket namespaces:

- **Standard Events**: `connect`, `disconnect`, `error`, `message`
- **Custom Events**: `chat:message`, `game:move`, `user:status`
- **Namespaced Events**: `namespace:action`, `service:method`
- **Dynamic Events**: Any event name that clients or backend might use
- **Complex Events**: Events with multiple arguments and complex data structures

## 🚀 Running the Tests

### Prerequisites
- Node.js 16+ installed
- Dependencies installed (`npm install`)
- NestJS CLI available (`npm install -g @nestjs/cli`)

### Quick Start
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:cov

# Run only unit tests
npm test -- --testPathPattern="*.spec.ts"

# Run only e2e tests
npm test -- --testPathPattern="*.e2e-spec.ts"
```

### Using the Test Runner Script
```bash
# Run all tests
node test-runner.js

# Run specific test types
node test-runner.js unit      # Unit tests only
node test-runner.js e2e       # End-to-end tests only
node test-runner.js coverage  # Tests with coverage
node test-runner.js watch     # Tests in watch mode
```

### Individual Test Files
```bash
# Run unit tests
npm test src/proxy/proxy.gateway.spec.ts

# Run e2e tests
npm test src/proxy/proxy.gateway.e2e.spec.ts
```

## 🧪 Test Environment

### Mock Backend Server
The e2e tests create a mock backend server that:
- Runs on port 8081 (configurable via `NEXTJS_TARGET`)
- Echoes back all received messages for verification
- Handles multiple concurrent connections
- Simulates real backend behavior

### Environment Variables
```bash
NEXTJS_TARGET=http://localhost:8081  # Backend server URL
PORT=3000                           # Proxy server port
NODE_ENV=test                      # Test environment
```

### Test Timeouts
- Unit tests: 5 seconds default
- E2E tests: 30 seconds (configurable)
- Load tests: 30 seconds for multiple connections

## 📊 Test Results

### Expected Output
```
🧪 Running WebSocket Proxy Gateway Tests...

📋 Test Plan:
1. Unit tests for ProxyGateway
2. End-to-end tests for WebSocket functionality
3. Integration tests for namespace interception
4. Performance and load tests

🔬 Running unit tests...
✅ unit tests completed successfully

🌐 Running end-to-end tests...
✅ e2e tests completed successfully

📊 Running tests with coverage...
✅ coverage tests completed successfully

🎉 All tests completed successfully!

📈 Test Coverage Summary:
- Unit tests: ProxyGateway class, methods, and edge cases
- E2E tests: Real WebSocket connections and message forwarding
- Namespace tests: All possible WebSocket namespaces intercepted
- Performance tests: Multiple connections and load handling
- Error handling: Connection failures, malformed data, timeouts
```

### Coverage Report
After running tests with coverage, you'll find a detailed report in the `coverage/` directory showing:
- Line coverage percentage
- Branch coverage percentage
- Function coverage percentage
- Uncovered code sections

## 🔍 Test Scenarios

### Namespace Interception Verification
The tests verify that the proxy gateway intercepts and forwards:

1. **Simple Events**: `message`, `ping`, `pong`
2. **Namespaced Events**: `chat:message`, `game:move`, `user:status`
3. **Custom Events**: `notification:alert`, `file:upload`, `api:call`
4. **Dynamic Events**: Any event name that follows Socket.IO conventions
5. **Complex Events**: Events with objects, arrays, and nested data

### Message Forwarding Tests
- **Client → Backend**: All client events are forwarded to backend
- **Backend → Client**: All backend events are forwarded to client
- **System Event Filtering**: System events like `connect`, `disconnect` are not forwarded
- **Data Integrity**: Complex data structures are preserved during transmission

### Connection Management
- **Multiple Clients**: Each client gets independent backend connection
- **Connection Recovery**: Automatic reconnection and message queuing
- **Resource Cleanup**: Proper disconnection and cleanup on both sides
- **Load Handling**: Multiple concurrent connections without interference

## 🐛 Troubleshooting

### Common Issues

1. **Port Conflicts**
   ```bash
   # Check if ports are in use
   netstat -an | grep :8081
   netstat -an | grep :3000
   ```

2. **Test Timeouts**
   ```bash
   # Increase timeout for slow systems
   jest --testTimeout=60000
   ```

3. **Mock Backend Issues**
   ```bash
   # Ensure mock backend is running
   # Check environment variables
   echo $NEXTJS_TARGET
   ```

4. **Socket.IO Version Mismatches**
   ```bash
   # Check installed versions
   npm list socket.io socket.io-client
   ```

### Debug Mode
```bash
# Run tests with debug output
npm run test:debug

# Run specific test with verbose output
npm test -- --verbose --testPathPattern="*.spec.ts"
```

## 📝 Adding New Tests

### Unit Test Structure
```typescript
describe('Feature Name', () => {
  beforeEach(() => {
    // Setup mocks and test data
  });

  it('should handle specific scenario', () => {
    // Test implementation
    expect(result).toBe(expected);
  });
});
```

### E2E Test Structure
```typescript
it('should handle real WebSocket scenario', (done) => {
  const socket = io('http://localhost:3000');
  
  socket.on('connect', () => {
    // Test implementation
    done();
  });
});
```

### Test Naming Conventions
- **Unit Tests**: `*.spec.ts` (e.g., `proxy.gateway.spec.ts`)
- **E2E Tests**: `*.e2e-spec.ts` (e.g., `proxy.gateway.e2e.spec.ts`)
- **Test Files**: Descriptive names that indicate what's being tested

## 🔧 Configuration

### Jest Configuration
The test suite uses Jest with the following configuration:
- TypeScript support via `ts-jest`
- Coverage reporting
- Test environment setup
- Custom test patterns for different test types

### Test Setup
- Global test environment configuration
- Console output mocking
- Environment variable setup
- Timeout configuration

## 📚 Additional Resources

- [Jest Testing Framework](https://jestjs.io/)
- [NestJS Testing](https://docs.nestjs.com/fundamentals/testing)
- [Socket.IO Testing](https://socket.io/docs/v4/testing/)
- [WebSocket Testing Best Practices](https://websockets.readthedocs.io/en/stable/testing.html)

## 🤝 Contributing

When adding new tests:
1. Follow the existing test structure and naming conventions
2. Ensure comprehensive coverage of new functionality
3. Include both unit and e2e tests where appropriate
4. Update this README with new test scenarios
5. Run the full test suite before submitting changes

## 📞 Support

For test-related issues:
1. Check the troubleshooting section above
2. Review test logs and error messages
3. Ensure all dependencies are properly installed
4. Verify environment configuration
5. Check for port conflicts or resource issues

