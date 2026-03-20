const serviceTradeService = require('../services/serviceTradeService');
const supabaseService = require('../services/supabaseService');

/**
 * Helper function to convert Unix epoch to human-readable date/time
 */
const formatUnixToDateTime = (unixTimestamp) => {
    if (!unixTimestamp) return null;
    // Convert to milliseconds if timestamp is in seconds (check if it's less than year 2001 in milliseconds)
    const timestamp = unixTimestamp < 10000000000 ? unixTimestamp * 1000 : unixTimestamp;
    return new Date(timestamp).toISOString();
};

/**
 * Get ServiceTrade authentication token for an agent
 * @param {string} agentId - The agent ID
 * @returns {Promise<string>} - The authentication token
 * @throws {Error} - If no token is found
 */
const getAuthToken = async (agentId) => {
    if (!agentId) {
        throw new Error('agentId is required');
    }
    
    if (!agentId.includes('agent_')) {
        throw new Error('agentId should start with agent_');
    }
    
    const tokenData = await supabaseService.getServiceTradeToken(agentId);
    
    if (!tokenData || tokenData.length === 0) {
        throw new Error('No ServiceTrade token found for this agent');
    }
    
    return tokenData[0].auth_token;
};

// Calculate timezone offset (minutes) for a given IANA timezone versus UTC at a specific date
const getOffsetForTimeZone = (date, timeZone) => {
    // date: Date in server timezone
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone }));
    return (tzDate.getTime() - utcDate.getTime()) / (60 * 1000);
};

const formatOffset = (minutesOffset) => {
    const sign = minutesOffset <= 0 ? '-' : '+';
    const abs = Math.abs(minutesOffset);
    const hours = String(Math.floor(abs / 60)).padStart(2, '0');
    const minutes = String(abs % 60).padStart(2, '0');
    return `${sign}${hours}:${minutes}`;
};

const isValidDateString = (dateString) => /^\d{4}-\d{2}-\d{2}$/.test(dateString);
const isValidTimeString = (timeString) => /^\d{2}:\d{2}(:\d{2})?$/.test(timeString);
const normalizeTimeString = (timeString) => {
    if (!timeString) return null;
    const parts = timeString.split(':');
    if (parts.length === 2) {
        return `${parts[0]}:${parts[1]}:00`;
    }
    if (parts.length === 3) {
        return timeString;
    }
    return null;
};

// Build a Date in UTC that represents the given wall time in the target timezone
const buildDateInTimeZone = (dateString, timeString, timeZone) => {
    if (dateString && timeString) {
        const normalizedTime = normalizeTimeString(timeString);
        const baseDate = new Date(`${dateString}T${normalizedTime}Z`);
        const offsetMinutes = getOffsetForTimeZone(baseDate, timeZone);
        const offsetStr = formatOffset(offsetMinutes);
        return new Date(`${dateString}T${normalizedTime}${offsetStr}`);
    }

    // If no explicit date/time provided, use "now" in the target timezone
    const now = new Date();
    const offsetMinutes = getOffsetForTimeZone(now, timeZone);
    const offsetStr = formatOffset(offsetMinutes);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(now);

    const getPart = (type) => parts.find(p => p.type === type)?.value;
    const yyyy = getPart('year');
    const mm = getPart('month');
    const dd = getPart('day');
    const hh = getPart('hour');
    const mi = getPart('minute');
    const ss = getPart('second');

    return new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${offsetStr}`);
};

/**
 * Get customer information from ServiceTrade by phone number
 * @param {string} fromPhoneNumber - The phone number to search for
 * @param {string} agentId - The agent ID
 * @returns {Promise<Object>} - Customer information including locationId
 * @throws {Error} - If customer is not found or validation fails
 */
const getCustomerByPhone = async (fromPhoneNumber, agentId) => {
    if (!fromPhoneNumber) {
        throw new Error('from_phone_number is required');
    }
    
    if (!agentId) {
        throw new Error('agentId is required');
    }
    
    console.log('🔍 Looking up customer by phone:', fromPhoneNumber);
    const supabaseAuthToken = await getAuthToken(agentId);
    
    // First, try to get contact from ServiceTrade (fast)
    const serviceTradeData = await serviceTradeService.getContacts(supabaseAuthToken, fromPhoneNumber);
    
    // If contact found with locations, return it immediately
    if (serviceTradeData && serviceTradeData.locations && serviceTradeData.locations.length > 0) {
        console.log('✅ Contact found via contact search');
        
        // Map all locations to simplified format
        const locations = serviceTradeData.locations.map(loc => ({
            id: loc.id,
            name: loc.name,
            address: {
                street: loc.address.street,
                city: loc.address.city,
                state: loc.address.state,
                postalCode: loc.address.postalCode
            }
        }));
        
        if (locations.length > 1) {
            console.log(`⚠️ Contact has ${locations.length} locations — callers should use 'locations' array, not 'locationId'`);
        }

        return {
            name: serviceTradeData.firstName + ' ' + serviceTradeData.lastName,
            phone: serviceTradeData.phone,
            email: serviceTradeData.email,
            customerId: serviceTradeData.id,
            locations: locations,
            // DEPRECATED: locationId is the first match and may be WRONG for multi-location contacts.
            // Callers should iterate over 'locations' instead.
            locationId: serviceTradeData.locations[0].id,
            companyId: serviceTradeData.company?.id || null,
            address: serviceTradeData.locations[0].address.street + ', ' + 
                     serviceTradeData.locations[0].address.city + ', ' + 
                     serviceTradeData.locations[0].address.state + ', ' + 
                     serviceTradeData.locations[0].address.postalCode
        };
    }
    
    // If contact not found, fallback to searching all locations (slower)
    console.log('⚠️ Contact not found, searching all locations (this may take a while)...');
    const locationData = await serviceTradeService.getLocations(supabaseAuthToken);
    const normalizePhone = (phone) => phone ? phone.replace(/[()-\s]/g, '') : '';
    const locationContactData = locationData.filter(({ primaryContact, phoneNumber }) => {
        const normalizedSearch = normalizePhone(fromPhoneNumber);
        const primaryMatch = primaryContact?.phone
            ? normalizePhone(primaryContact.phone) === normalizedSearch
            : false;
        const locationMatch = phoneNumber
            ? normalizePhone(phoneNumber) === normalizedSearch
            : false;
        return primaryMatch || locationMatch;
    });
    
    if (locationContactData.length > 0) {
        console.log('✅ Contact found via location search');
        
        // Map all matching locations to simplified format
        const locations = locationContactData.map(loc => ({
            id: loc.id,
            name: loc.name,
            address: {
                street: loc.address.street,
                city: loc.address.city,
                state: loc.address.state,
                postalCode: loc.address.postalCode
            }
        }));
        
        if (locations.length > 1) {
            console.log(`⚠️ Contact has ${locations.length} locations — callers should use 'locations' array, not 'locationId'`);
        }

        const primaryContact = locationContactData[0].primaryContact || null;
        return {
            name: locationContactData[0].name || (primaryContact ? `${primaryContact.firstName} ${primaryContact.lastName}` : ''),
            phone: primaryContact?.phone || '',
            email: primaryContact?.email || '',
            customerId: primaryContact?.id || null,
            locations: locations,
            // DEPRECATED: locationId is the first match and may be WRONG for multi-location contacts.
            // Callers should iterate over 'locations' instead.
            locationId: locationContactData[0].id,
            companyId: locationContactData[0].company?.id || null,
            address: locationContactData[0].address.street + ', ' + 
                     locationContactData[0].address.city + ', ' + 
                     locationContactData[0].address.state + ', ' + 
                     locationContactData[0].address.postalCode
        };
    }
    
    throw new Error('Customer not found');
};

/**
 * Get jobs for a location from ServiceTrade
 * @param {string} locationId - The location ID
 * @param {string} agentId - The agent ID
 * @param {string} status - The job status filter
 * @returns {Promise<Array>} - Array of job details
 * @throws {Error} - If validation fails or jobs cannot be retrieved
 */
const getJobsByLocation = async (locationId, agentId, status) => {
    if (!locationId) {
        throw new Error('locationId is required');
    }
    
    if (!agentId) {
        throw new Error('agentId is required');
    }
    
    const supabaseAuthToken = await getAuthToken(agentId);
    
    // Get jobs from ServiceTrade
    const serviceTradeData = await serviceTradeService.getJobs(supabaseAuthToken, locationId, status);
    
    // Format job details with date/time conversion
    const jobDetails = serviceTradeData.map(job => ({
        jobId: job.id,
        jobName: job.name,
        jobDescription: job.description,
        jobStatus: job.displayStatus,
        jobDueBy: formatUnixToDateTime(job.dueBy),
        jobDueAfter: formatUnixToDateTime(job.dueAfter),
        appointment: {...job.currentAppointment}
    }));
    
    return jobDetails;
};

/**
 * Get jobs for a customer by phone number (calls customer lookup first)
 * Queries jobs across ALL locations the contact is associated with to avoid
 * returning jobs from an arbitrary single location.
 * @param {string} fromPhoneNumber - The phone number to search for
 * @param {string} agentId - The agent ID
 * @param {string} status - The job status filter
 * @returns {Promise<Object>} - Object containing customer info and job details
 * @throws {Error} - If customer or validation fails
 */
const getJobsByPhone = async (fromPhoneNumber, agentId, status) => {
    // Step 1: Get customer information first (includes all locations)
    const customerData = await getCustomerByPhone(fromPhoneNumber, agentId);
    
    // Step 2: Get jobs across ALL locations the contact is associated with
    const locations = customerData.locations || [];
    const locationIds = locations.map(loc => loc.id).filter(Boolean);
    
    if (locationIds.length === 0) {
        throw new Error('Customer has no associated locations');
    }

    const jobPromises = locationIds.map(locId =>
        getJobsByLocation(locId, agentId, status).catch(err => {
            console.log(`⚠️ Failed to fetch jobs for location ${locId}:`, err.message);
            return [];
        })
    );
    const jobArrays = await Promise.all(jobPromises);
    const allJobs = jobArrays.flat();

    // Deduplicate by jobId in case the same job appears under multiple locations
    const seen = new Set();
    const jobDetails = allJobs.filter(job => {
        if (seen.has(job.jobId)) return false;
        seen.add(job.jobId);
        return true;
    });
    
    return {
        customer: {
            name: customerData.name,
            phone: customerData.phone,
            email: customerData.email,
            locations: locations,
            // Backward compat — prefer using 'locations' array
            locationId: customerData.locationId,
            address: customerData.address,
            customerId: customerData.customerId
        },
        jobDetails
    };
};

const getInvoicesByJobId = async (jobId, agentId) => {
    if (!jobId) {
        throw new Error('jobId is required');
    }
    
    if (!agentId) {
        throw new Error('agentId is required');
    }
    
    const supabaseAuthToken = await getAuthToken(agentId);
    
    // Get invoices from ServiceTrade
    const serviceTradeData = await serviceTradeService.getInvoices(supabaseAuthToken, jobId);
    
    return serviceTradeData;
};

/**
 * Round time UP to nearest 15-minute interval (00, 15, 30, 45)
 * @param {Date} date - Date object to round
 * @returns {Date} - Rounded date object
 */
const roundTimeUpToQuarter = (date) => {
    const minutes = date.getMinutes();
    const roundedMinutes = Math.ceil(minutes / 15) * 15;
    
    // Create new date to avoid mutating original
    const rounded = new Date(date);
    rounded.setMinutes(roundedMinutes);
    rounded.setSeconds(0);
    rounded.setMilliseconds(0);
    
    console.log(`⏰ Rounded time from ${date.toLocaleTimeString()} to ${rounded.toLocaleTimeString()}`);
    return rounded;
};

/**
 * Parse address string into components
 * @param {string} addressString - Raw address string
 * @param {string} state - State name or abbreviation
 * @returns {Object} - Parsed address components
 */
const parseAddress = (addressString, state) => {
    console.log('Parsing address:', addressString, 'State:', state);
    
    // State name to abbreviation mapping
    const stateAbbreviations = {
        'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
        'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
        'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
        'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
        'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
        'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
        'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
        'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
        'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
        'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
        'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
        'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
        'wisconsin': 'WI', 'wyoming': 'WY'
    };
    
    // Simple parsing - can be enhanced based on actual address formats
    const parts = addressString.split(',').map(p => p.trim());
    
    // Convert state to abbreviation if it's a full name
    let stateAbbr = state;
    if (state && state.length > 2) {
        stateAbbr = stateAbbreviations[state.toLowerCase()] || state.substring(0, 2).toUpperCase();
    }
    
    const parsed = {
        street: parts[0] || addressString || 'Unknown',
        city: parts[1] || 'Unknown',
        state: stateAbbr || 'TX',
        postalCode: parts[parts.length - 1]?.match(/\d{4,5}/)?.[0] || '00000'
    };
    
    console.log('Parsed address:', JSON.stringify(parsed));
    return parsed;
};

/**
 * Create a job in ServiceTrade for an existing customer
 * Requires locationId and companyId (vendorId) - no customer creation
 * @param {Object} jobData - Job data including locationId, companyId, and job details
 * @param {string} agentId - The agent ID
 * @returns {Promise<Object>} - Created job with ID and appointment
 */
const createJob = async (jobData, agentId) => {
    try {
        const {
            locationId,
            companyId, // This is the vendorId (may be provided in request)
            type = null,
            description = 'Service request from call',
            appointmentDate = null,
            appointmentTime = null,
            primaryContactId = null,
            callerPhoneNumber = null, // Add caller's phone number
            call_id = null,
            customName = null,
            jobDurationMinutes = null,
            serviceLineId = null,
            timezone = null,
            techIds = [],
            released = null
        } = jobData;

        // Validate required fields that are not config-driven
        if (!agentId) {
            throw new Error('Missing required field: agent_id');
        }
        if (!locationId) {
            throw new Error('Missing required field: locationId');
        }
        if ((appointmentDate && !appointmentTime) || (!appointmentDate && appointmentTime)) {
            throw new Error('appointmentDate and appointmentTime must be provided together');
        }
        if (appointmentDate && !isValidDateString(appointmentDate)) {
            throw new Error('Invalid appointmentDate format. Expected YYYY-MM-DD');
        }
        if (appointmentTime && !isValidTimeString(appointmentTime)) {
            throw new Error('Invalid appointmentTime format. Expected HH:MM or HH:MM:SS');
        }

        // Load job config overrides for this agent, if present
        const jobConfig = await supabaseService.getJobConfig(agentId).catch((err) => {
            console.error('⚠️ Could not fetch job config:', err.message);
            return null;
        });

        // Determine vendorId and ensure one is present from either request or config
        const resolvedVendorId = companyId || jobConfig?.vendor_id;
        if (!resolvedVendorId) {
            throw new Error('Missing required field: companyId (vendorId) and no vendor_id found in job config');
        }

        const supabaseAuthToken = await getAuthToken(agentId);

        console.log('📋 Creating job at Location ID:', locationId);

        // Merge config-driven defaults
        const resolvedType = type || jobConfig?.job_type || 'Service Call';
        const resolvedCustomName = customName || jobConfig?.custom_name || 'After Hours Service Call';
        const resolvedJobDurationMinutes = Number(jobDurationMinutes || jobConfig?.job_duration || 120); // minutes
        if (!resolvedJobDurationMinutes || Number.isNaN(resolvedJobDurationMinutes) || resolvedJobDurationMinutes <= 0) {
            throw new Error('Invalid job duration (minutes)');
        }
        const resolvedServiceLineId = serviceLineId || jobConfig?.service_line_id || 1;
        const resolvedTimeZone = timezone || jobConfig?.timezone || 'America/Toronto';
        const resolvedTechIds = Array.isArray(techIds) ? techIds : [];
        const resolvedReleased = (() => {
            const cfg = jobConfig?.appointment_released;
            if (released !== null && released !== undefined) return Boolean(released);
            if (cfg !== null && cfg !== undefined) return Boolean(cfg);
            return true; // default behavior
        })();

        const normalizedAppointmentTime = normalizeTimeString(appointmentTime);
        let appointmentDateTime = buildDateInTimeZone(appointmentDate, normalizedAppointmentTime, resolvedTimeZone);
        console.log(`ℹ️ Appointment time in ${resolvedTimeZone}:`, appointmentDateTime.toLocaleString('en-US', { timeZone: resolvedTimeZone }));
        appointmentDateTime = roundTimeUpToQuarter(appointmentDateTime);
        console.log(`📅 Final appointment time in ${resolvedTimeZone}:`, appointmentDateTime.toLocaleString('en-US', { timeZone: resolvedTimeZone }));

        // If caller phone number provided, look up their contact ID
        let callerContactId = primaryContactId;
        if (callerPhoneNumber && !primaryContactId) {
            try {
                console.log('📞 Looking up caller contact ID for phone:', callerPhoneNumber);
                const callerData = await getCustomerByPhone(callerPhoneNumber, agentId);
                callerContactId = callerData.customerId || null;
                console.log('✅ Found caller contact ID:', callerContactId);
            } catch (error) {
                console.log('⚠️ Could not find caller contact ID:', error.message);
                // Continue without primary contact
            }
        }

        if (!callerContactId) {
            try {
                console.log('🔎 Fetching location primary contact for location:', locationId);
                const location = await serviceTradeService.getLocationById(supabaseAuthToken, locationId);
                callerContactId = location?.primaryContact?.id || location?.primaryContactId || null;
                if (callerContactId) {
                    console.log('✅ Found location primary contact ID:', callerContactId);
                }
            } catch (error) {
                console.log('⚠️ Could not resolve location primary contact:', error.message);
            }
        }

        // Build dueBy date if provided
        let dueByDate = null;
        if (appointmentDate && appointmentTime) {
            dueByDate = appointmentDateTime.toISOString();
        }

        // Create Job
        const job = await serviceTradeService.createJob(supabaseAuthToken, locationId, {
            vendorId: resolvedVendorId,
            type: resolvedType,
            customName: resolvedCustomName,
            description: description,
            dueBy: dueByDate,
            primaryContactId: callerContactId
        });

        if (!job || !job.id) {
            throw new Error('Job creation failed - no ID returned');
        }

        console.log('✅ Job created:', job.id);

        // Create Appointment - without technician assignment
        let appointment = null;
        let serviceRequest = null;
        let appointmentErrorMessage = null;
        let serviceRequestErrorMessage = null;
        try {
            console.log('📅 Creating appointment for job:', job.id);

            // Convert date/time to Unix timestamp (seconds)
            const windowStart = Math.floor(appointmentDateTime.getTime() / 1000);
            const windowEnd = windowStart + (resolvedJobDurationMinutes * 60); // duration in seconds
            
            appointment = await serviceTradeService.createAppointment(supabaseAuthToken, {
                jobId: job.id,
                windowStart: windowStart,
                windowEnd: windowEnd,
                techIds: resolvedTechIds,
                serviceRequestIds: [],
                released: resolvedReleased
            });
            
            console.log('✅ Appointment created:', appointment?.id || 'success');
            console.log('ℹ️ No technicians assigned - appointment created without technician assignment');

            // Create service request and link it to the appointment (if appointment was created)
            if (appointment && appointment.id) {
                try {
                    console.log('📋 Creating service request');
                    console.log('📋 Service request data:', {
                        description: description,
                        locationId: locationId,
                        jobId: job.id,
                        appointmentIds: [appointment.id],
                        serviceLineId: resolvedServiceLineId
                    });
                    
                    serviceRequest = await serviceTradeService.createServiceRequest(supabaseAuthToken, {
                        description: description,
                        locationId: locationId,
                        serviceLineId: resolvedServiceLineId,
                        jobId: job.id,
                        appointmentIds: [appointment.id]
                    });
                    
                    console.log('✅ Service request created successfully:', JSON.stringify(serviceRequest, null, 2));
                } catch (serviceRequestError) {
                    console.error('❌ Service request creation failed:', serviceRequestError.message);
                    console.error('❌ Service request error stack:', serviceRequestError.stack);
                    serviceRequestErrorMessage = serviceRequestError.message || 'Service request creation failed';
                    // Don't fail the entire job creation if service request fails
                }
            } else {
                console.log('⚠️ Skipping service request creation - no appointment created');
            }
        } catch (appointmentError) {
            console.error('⚠️ Appointment creation failed:', appointmentError.message);
            appointmentErrorMessage = appointmentError.message || 'Appointment creation failed';
            // Don't fail the entire job creation if appointment fails
        }

        if (callerContactId && !job.primaryContactId && !primaryContactId) {
            try {
                console.log('📝 Updating job primary contact:', callerContactId);
                await serviceTradeService.updateJob(supabaseAuthToken, job.id, { primaryContactId: callerContactId });
            } catch (error) {
                console.error('⚠️ Failed to update job primary contact:', error.message);
            }
        }

        const result = {
            jobId: job.id,
            jobUri: job.uri || null,
            jobNumber: job.number || job.refNumber || null,
            locationId: locationId,
            companyId: companyId,
            callId: call_id,
            appointmentCreated: Boolean(appointment && appointment.id),
            serviceRequestCreated: Boolean(appointment && appointment.id && !serviceRequestErrorMessage),
            appointmentError: appointmentErrorMessage,
            serviceRequestError: serviceRequestErrorMessage
        };

        if (appointment) {
            result.appointmentId = appointment.id || null;
            result.appointmentUri = appointment.uri || null;
            
            // Build appointment window with the rounded time that was actually used
            result.appointmentWindow = {
                start: appointmentDateTime.toISOString(),
                end: new Date(appointmentDateTime.getTime() + resolvedJobDurationMinutes * 60 * 1000).toISOString()
            };
        }

        if (serviceRequest) {
            result.serviceRequestId = serviceRequest.id || null;
            result.serviceRequestUri = serviceRequest.uri || null;
        }

        return result;

    } catch (error) {
        console.error('❌ Job creation failed:', error.message);
        throw error;
    }
};



module.exports = {
    getAuthToken,
    getCustomerByPhone,
    getJobsByLocation,
    getJobsByPhone,
    formatUnixToDateTime,
    getInvoicesByJobId,
    createJob,
    parseAddress,
    roundTimeUpToQuarter
};


