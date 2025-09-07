require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Environment configs
const PORT = process.env.PORT || 5000;
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:5001/recommend";
const DB_CONNECTION_TIMEOUT = parseInt(process.env.DB_TIMEOUT) || 5000;
const AI_SERVICE_TIMEOUT = parseInt(process.env.AI_TIMEOUT) || 20000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// 🔧 FIELD MAPPINGS - Change these if your teammates use different field names
const FIELD_MAPPINGS = {
  candidate: {
    name: process.env.CANDIDATE_NAME_FIELD || 'name',
    sector: process.env.CANDIDATE_SECTOR_FIELD || 'sector',
    skills: process.env.CANDIDATE_SKILLS_FIELD || 'skills',
    experience: process.env.CANDIDATE_EXPERIENCE_FIELD || 'experience'
  },
  dbMethods: {
    getDropdowns: process.env.DB_GET_DROPDOWNS_METHOD || 'getDropdowns',
    saveCandidate: process.env.DB_SAVE_CANDIDATE_METHOD || 'saveCandidate',
    fetchCareers: process.env.DB_FETCH_CAREERS_METHOD || 'fetchCareers',
    updateRecommendations: process.env.DB_UPDATE_RECS_METHOD || 'updateCandidateRecommendations',
    createUser: process.env.DB_CREATE_USER_METHOD || 'createUser',
    findUserByEmail: process.env.DB_FIND_USER_METHOD || 'findUserByEmail'
  }
};

// Utility functions
const withTimeout = (promise, timeoutMs, operation) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`${operation} timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
};

const validateCandidate = (candidate) => {
  const errors = [];
  if (!candidate[FIELD_MAPPINGS.candidate.name]) errors.push('Name is required');
  if (!candidate[FIELD_MAPPINGS.candidate.sector]) errors.push('Sector is required');
  return errors;
};

const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Get database service
const getDbService = () => {
  try {
    return require('./dbService');
  } catch (error) {
    throw new Error('Database service not found. Make sure dbService.js exists.');
  }
};

// ======================= HEALTH CHECK ROUTES =======================

app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {},
    fieldMappings: FIELD_MAPPINGS
  };

  // Check database
  try {
    const db = getDbService();
    const method = FIELD_MAPPINGS.dbMethods.getDropdowns;
    if (typeof db[method] === 'function') {
      health.services.database = 'connected';
    } else {
      health.services.database = `missing method: ${method}`;
      health.status = 'degraded';
    }
  } catch (error) {
    health.services.database = `error: ${error.message}`;
    health.status = 'degraded';
  }

  // Check AI service
  try {
    await axios.get(AI_SERVICE_URL.replace('/recommend', '/health'), { timeout: 3000 });
    health.services.aiService = 'connected';
  } catch (error) {
    health.services.aiService = `error: ${error.message}`;
    health.status = 'degraded';
  }

  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

app.get('/api/test-integration', (req, res) => {
  const tests = {};

  // Test database service
  try {
    const db = getDbService();
    const methods = Object.values(FIELD_MAPPINGS.dbMethods);
    tests.database = {
      loaded: true,
      methods: methods.reduce((acc, method) => {
        acc[method] = typeof db[method] === 'function';
        return acc;
      }, {})
    };
  } catch (error) {
    tests.database = { loaded: false, error: error.message };
  }

  tests.fieldMappings = FIELD_MAPPINGS;
  res.json({ tests });
});

// ======================= AUTHENTICATION ROUTES =======================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validate input
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Name, email, and password are required'
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }

    const db = getDbService();
    const findMethod = FIELD_MAPPINGS.dbMethods.findUserByEmail;
    const createMethod = FIELD_MAPPINGS.dbMethods.createUser;

    // Check if user exists
    if (typeof db[findMethod] === 'function') {
      const existingUser = await db[findMethod](email);
      if (existingUser) {
        return res.status(409).json({
          success: false,
          error: 'User already exists with this email'
        });
      }
    }

    // Hash password and create user
    const hashedPassword = await bcrypt.hash(password, 10);
    const userData = { name, email: email.toLowerCase(), password: hashedPassword };
    
    const userId = await db[createMethod](userData);
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '24h' });

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: { id: userId, name, email },
      token
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    const db = getDbService();
    const findMethod = FIELD_MAPPINGS.dbMethods.findUserByEmail;

    if (typeof db[findMethod] !== 'function') {
      throw new Error(`Database method ${findMethod} not found`);
    }

    const user = await db[findMethod](email.toLowerCase());
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '24h' });

    res.json({
      success: true,
      message: 'Login successful',
      user: { id: user.id, name: user.name, email: user.email },
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ======================= CAREER RECOMMENDATION ROUTES =======================

app.get('/api/dropdown-options', async (req, res) => {
  try {
    const db = getDbService();
    const method = FIELD_MAPPINGS.dbMethods.getDropdowns;
    
    if (typeof db[method] !== 'function') {
      throw new Error(`Database method ${method} not found`);
    }

    const dropdowns = await withTimeout(db[method](), DB_CONNECTION_TIMEOUT, 'Fetch dropdowns');
    
    res.json({ success: true, dropdowns });

  } catch (err) {
    console.error('Dropdown fetch error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dropdowns',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

app.post('/api/recommend', async (req, res) => {
  const startTime = Date.now();
  let candidateId = null;

  try {
    const candidate = req.body;

    // Validate input
    const validationErrors = validateCandidate(candidate);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: validationErrors
      });
    }

    const db = getDbService();

    // Step 1: Save candidate
    const saveMethod = FIELD_MAPPINGS.dbMethods.saveCandidate;
    candidateId = await withTimeout(db[saveMethod](candidate), DB_CONNECTION_TIMEOUT, 'Save candidate');

    // Step 2: Fetch careers
    const fetchMethod = FIELD_MAPPINGS.dbMethods.fetchCareers;
    const careers = await withTimeout(
      db[fetchMethod]({ sector: candidate[FIELD_MAPPINGS.candidate.sector] }),
      DB_CONNECTION_TIMEOUT,
      'Fetch careers'
    );

    // Step 3: Call AI service
    const aiResponse = await axios.post(AI_SERVICE_URL, { candidate, careers }, {
      timeout: AI_SERVICE_TIMEOUT,
      headers: { 'Content-Type': 'application/json' }
    });

    const recommendations = aiResponse.data;

    // Step 4: Save recommendations
    const updateMethod = FIELD_MAPPINGS.dbMethods.updateRecommendations;
    await withTimeout(db[updateMethod](candidateId, recommendations), DB_CONNECTION_TIMEOUT, 'Update recommendations');

    const processingTime = Date.now() - startTime;

    res.json({
      success: true,
      candidateId,
      recommendations,
      processingTime,
      metadata: {
        careersAnalyzed: careers.length,
        recommendationsGenerated: recommendations.length || 0
      }
    });

  } catch (err) {
    console.error('Recommendation error:', err);
    res.status(500).json({
      success: false,
      error: 'AI recommendation failed',
      candidateId,
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

app.post('/api/save-user', async (req, res) => {
  try {
    const candidate = req.body;

    const validationErrors = validateCandidate(candidate);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: validationErrors
      });
    }

    const db = getDbService();
    const method = FIELD_MAPPINGS.dbMethods.saveCandidate;
    const id = await withTimeout(db[method](candidate), DB_CONNECTION_TIMEOUT, 'Save user');

    res.json({ success: true, id });

  } catch (err) {
    console.error('Save user error:', err);
    res.status(500).json({ success: false, error: 'Failed to save user' });
  }
});

// Protected route example
app.get('/api/profile', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: req.user,
    message: 'This is a protected route'
  });
});

// ======================= ERROR HANDLERS =======================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found`
  });
});

// ======================= START SERVER =======================

const server = app.listen(PORT, () => {
  console.log(` Backend running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Integration test: http://localhost:${PORT}/api/test-integration`);
  console.log('Ready for teammate integration!');
});
