require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Environment configs with validation
const PORT = process.env.PORT || 5000;
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:5001/recommend";
const DB_CONNECTION_TIMEOUT = parseInt(process.env.DB_TIMEOUT) || 5000;
const AI_SERVICE_TIMEOUT = parseInt(process.env.AI_TIMEOUT) || 20000;

// 🔧 FIELD MAPPING CONFIGURATION - Change field names here!
const FIELD_MAPPINGS = {
  // Candidate fields mapping: internal_name -> external_field_name
  candidate: {
    name: process.env.CANDIDATE_NAME_FIELD || 'name',
    sector: process.env.CANDIDATE_SECTOR_FIELD || 'sector', 
    skills: process.env.CANDIDATE_SKILLS_FIELD || 'skills',
    experience: process.env.CANDIDATE_EXPERIENCE_FIELD || 'experience',
    education: process.env.CANDIDATE_EDUCATION_FIELD || 'education',
    preferences: process.env.CANDIDATE_PREFERENCES_FIELD || 'preferences',
    id: process.env.CANDIDATE_ID_FIELD || 'id'
  },
  
  // Database service method names - in case your teammate changes them
  dbMethods: {
    getDropdowns: process.env.DB_GET_DROPDOWNS_METHOD || 'getDropdowns',
    saveCandidate: process.env.DB_SAVE_CANDIDATE_METHOD || 'saveCandidate', 
    fetchCareers: process.env.DB_FETCH_CAREERS_METHOD || 'fetchCareers',
    updateRecommendations: process.env.DB_UPDATE_RECS_METHOD || 'updateCandidateRecommendations'
  },
  
  // Career filtering field - in case DB team changes the filter parameter
  careerFilter: {
    sector: process.env.CAREER_FILTER_FIELD || 'sector'
  },
  
  // AI Service payload structure
  aiPayload: {
    candidate: process.env.AI_CANDIDATE_KEY || 'candidate',
    careers: process.env.AI_CAREERS_KEY || 'careers'
  }
};

// Helper function to map fields between internal and external representation
const mapFields = (data, mapping, reverse = false) => {
  if (!data || typeof data !== 'object') return data;
  
  const mapped = {};
  
  if (reverse) {
    // External -> Internal (when receiving data)
    Object.entries(mapping).forEach(([internal, external]) => {
      if (data[external] !== undefined) {
        mapped[internal] = data[external];
      }
    });
  } else {
    // Internal -> External (when sending data)
    Object.entries(mapping).forEach(([internal, external]) => {
      if (data[internal] !== undefined) {
        mapped[external] = data[internal];
      }
    });
  }
  
  return mapped;
};

// Dynamic validation based on field mappings
const createCandidateSchema = () => ({
  required: [FIELD_MAPPINGS.candidate.name, FIELD_MAPPINGS.candidate.sector],
  optional: [
    FIELD_MAPPINGS.candidate.skills, 
    FIELD_MAPPINGS.candidate.experience, 
    FIELD_MAPPINGS.candidate.education, 
    FIELD_MAPPINGS.candidate.preferences
  ]
});

const validateCandidate = (candidate) => {
  const errors = [];
  const schema = createCandidateSchema();
  
  schema.required.forEach(field => {
    if (!candidate[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  });
  
  const nameField = FIELD_MAPPINGS.candidate.name;
  if (candidate[nameField] && typeof candidate[nameField] !== 'string') {
    errors.push(`${nameField} must be a string`);
  }
  
  return errors;
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

const retryOperation = async (operation, maxRetries = 3, delay = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.log(`Attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    }
  }
};

// Database service wrapper with dynamic method names
const getDbService = () => {
  try {
    return require('./dbService');
  } catch (error) {
    throw new Error('Database service not found. Make sure dbService.js exists and exports the required methods.');
  }
};

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {},
    fieldMappings: FIELD_MAPPINGS // Show current field mappings
  };

  // Check database connection with dynamic method names
  try {
    const db = getDbService();
    const getDropdownsMethod = FIELD_MAPPINGS.dbMethods.getDropdowns;
    
    if (typeof db[getDropdownsMethod] === 'function') {
      await withTimeout(db[getDropdownsMethod](), 3000, 'Database health check');
      health.services.database = 'connected';
    } else {
      health.services.database = `missing_method: ${getDropdownsMethod}`;
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

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Configuration endpoint to see current field mappings
app.get('/api/field-mappings', (req, res) => {
  res.json({
    success: true,
    mappings: FIELD_MAPPINGS,
    instructions: {
      message: "To change field mappings, update environment variables or modify FIELD_MAPPINGS object",
      examples: {
        "CANDIDATE_NAME_FIELD": "fullName",
        "CANDIDATE_SECTOR_FIELD": "industry", 
        "DB_SAVE_CANDIDATE_METHOD": "createCandidate"
      }
    }
  });
});

// Enhanced get dropdowns endpoint with dynamic method names
app.get('/api/dropdown-options', async (req, res) => {
  try {
    console.log('Fetching dropdown options...');
    
    const db = getDbService();
    const methodName = FIELD_MAPPINGS.dbMethods.getDropdowns;
    
    if (typeof db[methodName] !== 'function') {
      throw new Error(`Database service missing method: ${methodName}`);
    }

    const dropdowns = await withTimeout(
      db[methodName](), 
      DB_CONNECTION_TIMEOUT,
      'Database fetch dropdowns'
    );

    if (!dropdowns || typeof dropdowns !== 'object') {
      throw new Error('Invalid dropdowns response from database');
    }

    console.log('Successfully fetched dropdowns:', Object.keys(dropdowns));
    res.json({ success: true, dropdowns });

  } catch (err) {
    console.error('Dropdown fetch error:', err);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch dropdowns",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Enhanced recommend endpoint with field mapping support
app.post('/api/recommend', async (req, res) => {
  const startTime = Date.now();
  let candidateId = null;

  try {
    const candidateRaw = req.body;
    console.log('Processing recommendation request...');

    // Map incoming fields to internal representation
    const candidate = { ...candidateRaw }; // Keep original + mapped fields for flexibility

    // Validate input using mapped field names
    const validationErrors = validateCandidate(candidate);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: validationErrors,
        expectedFields: createCandidateSchema()
      });
    }

    const db = getDbService();

    // Validate all required DB methods exist using dynamic method names
    const dbMethods = FIELD_MAPPINGS.dbMethods;
    const requiredMethods = Object.values(dbMethods);
    const missingMethods = requiredMethods.filter(method => typeof db[method] !== 'function');
    
    if (missingMethods.length > 0) {
      throw new Error(`Database service missing methods: ${missingMethods.join(', ')}`);
    }

    // Step 1: Save candidate profile
    console.log('Step 1: Saving candidate profile...');
    candidateId = await retryOperation(
      () => withTimeout(db[dbMethods.saveCandidate](candidate), DB_CONNECTION_TIMEOUT, 'Save candidate'),
      2
    );
    console.log(`Candidate saved with ID: ${candidateId}`);

    // Step 2: Fetch relevant careers using dynamic filter field
    console.log('Step 2: Fetching relevant careers...');
    const sectorField = FIELD_MAPPINGS.candidate.sector;
    const filterField = FIELD_MAPPINGS.careerFilter.sector;
    
    const careerFilter = {};
    careerFilter[filterField] = candidate[sectorField];
    
    const careers = await withTimeout(
      db[dbMethods.fetchCareers](careerFilter),
      DB_CONNECTION_TIMEOUT,
      'Fetch careers'
    );

    if (!Array.isArray(careers)) {
      throw new Error('Invalid careers response - expected array');
    }

    console.log(`Found ${careers.length} relevant careers`);

    // Step 3: Call AI service with mapped payload structure
    console.log('Step 3: Calling AI recommendation service...');
    const aiMapping = FIELD_MAPPINGS.aiPayload;
    const aiPayload = {};
    aiPayload[aiMapping.candidate] = candidate;
    aiPayload[aiMapping.careers] = careers;
    
    const aiResponse = await retryOperation(async () => {
      const response = await axios.post(AI_SERVICE_URL, aiPayload, {
        timeout: AI_SERVICE_TIMEOUT,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': `rec-${Date.now()}`
        }
      });
      
      if (!response.data) {
        throw new Error('Empty response from AI service');
      }
      
      return response;
    }, 2, 2000);

    const recommendations = aiResponse.data;
    console.log(`Received ${recommendations.length || 0} recommendations from AI service`);

    // Step 4: Save recommendations
    console.log('Step 4: Saving recommendations...');
    await withTimeout(
      db[dbMethods.updateRecommendations](candidateId, recommendations),
      DB_CONNECTION_TIMEOUT,
      'Update recommendations'
    );

    const processingTime = Date.now() - startTime;
    console.log(`Recommendation process completed in ${processingTime}ms`);

    // Step 5: Return success response
    res.json({
      success: true,
      candidateId,
      recommendations,
      processingTime,
      metadata: {
        careersAnalyzed: careers.length,
        recommendationsGenerated: recommendations.length || 0,
        fieldsUsed: {
          candidateFields: Object.keys(candidate),
          filterField: filterField,
          aiPayloadStructure: Object.keys(aiPayload)
        }
      }
    });

  } catch (err) {
    const processingTime = Date.now() - startTime;
    console.error("Recommendation error:", {
      message: err.message,
      candidateId,
      processingTime,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });

    let statusCode = 500;
    if (err.message.includes('Validation failed')) statusCode = 400;
    if (err.message.includes('timeout')) statusCode = 408;
    if (err.code === 'ECONNREFUSED') statusCode = 503;

    res.status(statusCode).json({
      success: false,
      error: "AI recommendation failed",
      candidateId,
      processingTime,
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Enhanced save user endpoint with field mapping
app.post('/api/save-user', async (req, res) => {
  try {
    const candidate = req.body;
    console.log('Saving user profile...');

    // Validate input using mapped field names
    const validationErrors = validateCandidate(candidate);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: validationErrors,
        expectedFields: createCandidateSchema()
      });
    }

    const db = getDbService();
    const methodName = FIELD_MAPPINGS.dbMethods.saveCandidate;
    
    if (typeof db[methodName] !== 'function') {
      throw new Error(`Database service missing method: ${methodName}`);
    }

    const id = await withTimeout(
      db[methodName](candidate),
      DB_CONNECTION_TIMEOUT,
      'Save user'
    );

    console.log(`User saved with ID: ${id}`);
    res.json({ success: true, id });

  } catch (err) {
    console.error('Save user error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to save user',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Integration test endpoint with dynamic method validation
app.get('/api/test-integration', async (req, res) => {
  const tests = {};

  // Test database service with dynamic method names
  try {
    const db = getDbService();
    const dbMethods = FIELD_MAPPINGS.dbMethods;
    tests.database = {
      loaded: true,
      methods: Object.entries(dbMethods).reduce((acc, [key, methodName]) => {
        acc[`${key} (${methodName})`] = typeof db[methodName] === 'function';
        return acc;
      }, {}),
      fieldMappings: FIELD_MAPPINGS.candidate
    };
  } catch (error) {
    tests.database = { loaded: false, error: error.message };
  }

  // Test AI service connectivity
  try {
    const testResponse = await axios.get(AI_SERVICE_URL.replace('/recommend', '/health'), { timeout: 5000 });
    tests.aiService = { 
      reachable: true, 
      status: testResponse.status,
      expectedPayloadStructure: FIELD_MAPPINGS.aiPayload
    };
  } catch (error) {
    tests.aiService = { reachable: false, error: error.message };
  }

  // Test field mapping configuration
  tests.fieldMappings = {
    candidateFields: FIELD_MAPPINGS.candidate,
    dbMethods: FIELD_MAPPINGS.dbMethods,
    careerFilter: FIELD_MAPPINGS.careerFilter,
    aiPayload: FIELD_MAPPINGS.aiPayload
  };

  res.json({ tests });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found`
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Enhanced backend running at http://localhost:${PORT}`);
  console.log(`📊 Health check available at http://localhost:${PORT}/health`);
  console.log(`🔧 Integration test at http://localhost:${PORT}/api/test-integration`);
  console.log(`⚙️  Field mappings at http://localhost:${PORT}/api/field-mappings`);
  console.log(`🎯 Current field mappings:`, FIELD_MAPPINGS.candidate);
});