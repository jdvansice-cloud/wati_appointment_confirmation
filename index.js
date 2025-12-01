const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ===========================================
// CONFIGURATION
// ===========================================
const config = {
  wati: {
    endpoint: process.env.WATI_ENDPOINT || 'https://live-mt-server.wati.io/1036696',
    accessToken: process.env.WATI_ACCESS_TOKEN
  },
  mindbody: {
    webhookSecret: process.env.MINDBODY_WEBHOOK_SECRET
  },
  locations: {
    // Map Mindbody Location IDs to display names and addresses
    1: {
      name: 'Costa del Este',
      address: 'Star Plaza, Frente al Riba Smith, Costa del Este'
    },
    2: {
      name: 'San Francisco',
      address: 'C. 74 Este, San Francisco, al lado de la Delta de Calle 50'
    }
  },
  templateName: process.env.WATI_TEMPLATE_NAME || 'appointment_confirmation',
  port: process.env.PORT || 3000
};

// ===========================================
// WATI API FUNCTIONS
// ===========================================

/**
 * Send a template message via WATI
 */
async function sendWatiTemplateMessage(phoneNumber, templateName, parameters) {
  const url = `${config.wati.endpoint}/api/v1/sendTemplateMessage?whatsappNumber=${phoneNumber}`;
  
  try {
    const response = await axios.post(url, {
      template_name: templateName,
      broadcast_name: 'appointment_confirmation',
      parameters: parameters
    }, {
      headers: {
        'Authorization': config.wati.accessToken,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('✅ WATI message sent:', response.data);
    return { success: true, data: response.data };
  } catch (error) {
    console.error('❌ WATI error:', error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
}

/**
 * Format phone number for WhatsApp (remove spaces, dashes, ensure country code)
 */
function formatPhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all non-numeric characters
  let cleaned = phone.toString().replace(/\D/g, '');
  
  // Panama numbers: if starts with 6 and is 8 digits, add 507
  if (cleaned.length === 8 && cleaned.startsWith('6')) {
    cleaned = '507' + cleaned;
  }
  
  // If no country code and looks like Panama number
  if (cleaned.length === 8) {
    cleaned = '507' + cleaned;
  }
  
  return cleaned;
}

/**
 * Format date in Spanish
 */
function formatDateSpanish(dateString) {
  const date = new Date(dateString);
  const options = { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    timeZone: 'America/Panama'
  };
  
  let formatted = date.toLocaleDateString('es-PA', options);
  // Capitalize first letter
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

/**
 * Format time in 12-hour format
 */
function formatTime(dateString) {
  const date = new Date(dateString);
  return date.toLocaleTimeString('es-PA', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Panama'
  });
}

/**
 * Get location info from Mindbody location ID
 */
function getLocationInfo(locationId) {
  return config.locations[locationId] || config.locations[1] || {
    name: 'Mimosa Spa',
    address: 'Panamá'
  };
}

// ===========================================
// WEBHOOK ENDPOINTS
// ===========================================

/**
 * Health check endpoint
 */
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Mindbody-WATI Webhook',
    timestamp: new Date().toISOString()
  });
});

/**
 * Health check for Railway
 */
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

/**
 * HEAD request handler - Mindbody uses this to verify the webhook URL
 */
app.head('/webhook/mindbody/appointment', (req, res) => {
  res.status(200).end();
});

/**
 * Main webhook endpoint for Mindbody appointment events
 */
app.post('/webhook/mindbody/appointment', async (req, res) => {
  console.log('📥 Received Mindbody webhook:', JSON.stringify(req.body, null, 2));
  
  try {
    const payload = req.body;
    
    // Mindbody webhook payload structure
    const eventId = payload.eventId || payload.EventId;
    const eventData = payload.eventData || payload.EventData || payload;
    
    // Only process appointment created events (skip cancelled, updated if you want)
    if (eventId === 'appointmentBooking.cancelled') {
      console.log('⏭️ Skipping cancelled appointment event');
      return res.json({ received: true, processed: false, reason: 'Appointment cancelled' });
    }
    
    // Extract appointment details - Mindbody puts fields directly in eventData
    const clientName = eventData.clientFirstName || eventData.ClientFirstName || 'Cliente';
    const clientLastName = eventData.clientLastName || eventData.ClientLastName || '';
    const clientPhone = eventData.clientPhone || eventData.ClientPhone || 
                        eventData.clientMobilePhone || eventData.ClientMobilePhone;
    const serviceName = eventData.appointmentName || eventData.AppointmentName || 
                        eventData.serviceName || eventData.ServiceName || 'Servicio';
    const startDateTime = eventData.startDateTime || eventData.StartDateTime;
    const locationId = eventData.locationId || eventData.LocationId;
    
    // Validate required fields
    if (!clientPhone) {
      console.log('⚠️ No phone number found for client');
      console.log('Available eventData fields:', Object.keys(eventData));
      return res.json({ received: true, processed: false, reason: 'No phone number' });
    }
    
    if (!startDateTime) {
      console.log('⚠️ No start time found');
      return res.json({ received: true, processed: false, reason: 'No start time' });
    }
    
    // Format data
    const formattedPhone = formatPhoneNumber(clientPhone);
    const formattedDate = formatDateSpanish(startDateTime);
    const formattedTime = formatTime(startDateTime);
    const locationInfo = getLocationInfo(locationId);
    
    console.log('📋 Appointment details:', {
      client: clientName,
      phone: formattedPhone,
      service: serviceName,
      date: formattedDate,
      time: formattedTime,
      location: locationInfo.name
    });
    
    // Build template parameters for WATI
    // Order must match your template variables {{1}}, {{2}}, etc.
    const templateParams = [
      { name: '1', value: clientName },
      { name: '2', value: locationInfo.name },
      { name: '3', value: formattedDate },
      { name: '4', value: formattedTime },
      { name: '5', value: serviceName },
      { name: '6', value: locationInfo.address }
    ];
    
    // Send WhatsApp message
    const result = await sendWatiTemplateMessage(
      formattedPhone,
      config.templateName,
      templateParams
    );
    
    if (result.success) {
      console.log('✅ Confirmation sent successfully');
      res.json({ received: true, processed: true, whatsappSent: true });
    } else {
      console.log('❌ Failed to send confirmation:', result.error);
      res.json({ received: true, processed: true, whatsappSent: false, error: result.error });
    }
    
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

/**
 * Test endpoint - manually trigger a test message
 */
app.post('/test/send-confirmation', async (req, res) => {
  const { phone, name, service, date, time, location } = req.body;
  
  if (!phone) {
    return res.status(400).json({ error: 'Phone number required' });
  }
  
  const templateParams = [
    { name: '1', value: name || 'Test Cliente' },
    { name: '2', value: location || 'Costa del Este' },
    { name: '3', value: date || 'Lunes, 2 de diciembre 2024' },
    { name: '4', value: time || '2:00 PM' },
    { name: '5', value: service || 'Masaje Relajante 60 min' },
    { name: '6', value: 'Plaza Costa del Este' }
  ];
  
  const result = await sendWatiTemplateMessage(
    formatPhoneNumber(phone),
    config.templateName,
    templateParams
  );
  
  res.json(result);
});

/**
 * Debug endpoint - echo webhook payload
 */
app.post('/debug/webhook', (req, res) => {
  console.log('🔍 Debug webhook received:');
  console.log('Headers:', req.headers);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  res.json({ received: true, body: req.body });
});

// ===========================================
// START SERVER
// ===========================================
app.listen(config.port, () => {
  console.log(`🚀 Mindbody-WATI webhook server running on port ${config.port}`);
  console.log(`📡 WATI endpoint: ${config.wati.endpoint}`);
  console.log(`📝 Template: ${config.templateName}`);
});
