const logger = {
  info: (message, data) => {
    const timestamp = new Date().toISOString();
    if (data !== undefined) {
      console.log(`[${timestamp}] INFO: ${message}`, data);
    } else {
      console.log(`[${timestamp}] INFO: ${message}`);
    }
  },
  error: (message, err) => {
    const timestamp = new Date().toISOString();
    if (err !== undefined) {
      console.error(`[${timestamp}] ERROR: ${message}`, err);
    } else {
      console.error(`[${timestamp}] ERROR: ${message}`);
    }
  },
  success: (message, data) => {
    const timestamp = new Date().toISOString();
    if (data !== undefined) {
      console.log(`[${timestamp}] SUCCESS: ${message}`, data);
    } else {
      console.log(`[${timestamp}] SUCCESS: ${message}`);
    }
  },
};

module.exports = logger;
