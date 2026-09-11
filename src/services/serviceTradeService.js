class ServiceTradeService {
    constructor() {
        this.baseUrl = 'https://api.servicetrade.com/api';
    }

    async getInvoices(authToken, jobId) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const response = await fetch(`${this.baseUrl}/invoice?jobId=${jobId}`, {
                method: "GET",
                headers: {
                    "Cookie": cookieValue,
                    "Content-Type": "application/json"
                }
            });

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
            }

            const { data } = await response.json();
            return data.invoices;
        } catch (error) {
            console.error('Error fetching invoices from ServiceTrade:', error);
            throw error;
        }
    }

    async getContacts(authToken, phoneNumber) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const response = await fetch(`${this.baseUrl}/contact?search=${phoneNumber}`, {
                method: "GET",
                headers: {
                    "Cookie": cookieValue,
                    "Content-Type": "application/json"
                }
            });

            // Mirrors searchContacts below. Without this, a non-200 (or any empty body)
            // reaches response.json() and throws "Unexpected end of JSON input" — which
            // surfaces to the caller as an opaque 500 and is indistinguishable from
            // "this phone number matched nobody". The customer gate has to tell those
            // two apart, so the failure has to be labelled.
            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
            }

            const { data } = await response.json();
            return Array.isArray(data?.contacts) && data.contacts.length > 0 ? data.contacts[0] : null;
        } catch (error) {
            console.error('Error fetching contacts from ServiceTrade:', error);
            throw error;
        }
    }

    async searchContacts(authToken, searchQuery) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const response = await fetch(`${this.baseUrl}/contact?search=${encodeURIComponent(searchQuery)}`, {
                method: "GET",
                headers: {
                    "Cookie": cookieValue,
                    "Content-Type": "application/json"
                }
            });

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
            }

            const { data } = await response.json();
            return Array.isArray(data?.contacts) ? data.contacts : [];
        } catch (error) {
            console.error('Error searching contacts from ServiceTrade:', error);
            throw error;
        }
    }

    async searchLocationsByName(authToken, nameQuery) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const response = await fetch(
                `${this.baseUrl}/location?name=${encodeURIComponent(nameQuery)}&limit=100&status=active,inactive&isCustomer=true`,
                {
                    method: "GET",
                    headers: {
                        "Cookie": cookieValue,
                        "Content-Type": "application/json"
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
            }

            const { data } = await response.json();
            return Array.isArray(data?.locations) ? data.locations : [];
        } catch (error) {
            console.error('Error searching locations by name from ServiceTrade:', error);
            throw error;
        }
    }

    async searchLocations(authToken, searchQuery) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const response = await fetch(
                `${this.baseUrl}/location?search=${encodeURIComponent(searchQuery)}&status=active,inactive&isCustomer=true`,
                {
                    method: "GET",
                    headers: {
                        "Cookie": cookieValue,
                        "Content-Type": "application/json"
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
            }

            const { data } = await response.json();
            return Array.isArray(data?.locations) ? data.locations : [];
        } catch (error) {
            console.error('Error searching locations from ServiceTrade:', error);
            throw error;
        }
    }

    async searchCompaniesByName(authToken, nameQuery) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const response = await fetch(
                `${this.baseUrl}/company?name=${encodeURIComponent(nameQuery)}`,
                {
                    method: "GET",
                    headers: {
                        "Cookie": cookieValue,
                        "Content-Type": "application/json"
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
            }

            const { data } = await response.json();
            return Array.isArray(data?.companies) ? data.companies : [];
        } catch (error) {
            console.error('Error searching companies by name from ServiceTrade:', error);
            throw error;
        }
    }

    async searchLocationsByCompanyIds(authToken, companyIds) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            
            // Use companyId query param (comma-delimited list) for server-side filtering
            const companyIdsParam = companyIds.join(',');
            const response = await fetch(
                `${this.baseUrl}/location?companyId=${companyIdsParam}&status=active,inactive&isCustomer=true&limit=1000`,
                {
                    method: "GET",
                    headers: {
                        "Cookie": cookieValue,
                        "Content-Type": "application/json"
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
            }

            const { data } = await response.json();
            return Array.isArray(data?.locations) ? data.locations : [];
        } catch (error) {
            console.error('Error searching locations by company ids from ServiceTrade:', error);
            throw error;
        }
    }

    async searchLocationsByAddress(authToken, addressQuery) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            // Address matching scans ALL customer locations (active + inactive), not only
            // page 1. Inactive candidates are kept in the pool so the matcher can detect a
            // known-but-deactivated address; the confident-match selection prefers active.
            const firstResponse = await fetch(
                `${this.baseUrl}/location?page=1&status=active,inactive&isCustomer=true&limit=1000`,
                {
                    method: "GET",
                    headers: {
                        "Cookie": cookieValue,
                        "Content-Type": "application/json"
                    }
                }
            );

            if (!firstResponse.ok) {
                throw new Error(`ServiceTrade API error: ${firstResponse.status} ${firstResponse.statusText}`);
            }

            const { data: firstPageData } = await firstResponse.json();
            const totalPages = firstPageData?.totalPages || 1;
            const pagePromises = [];

            for (let page = 1; page <= totalPages; page += 1) {
                pagePromises.push(
                    fetch(`${this.baseUrl}/location?page=${page}&status=active,inactive&isCustomer=true&limit=1000`, {
                        method: "GET",
                        headers: {
                            "Cookie": cookieValue,
                            "Content-Type": "application/json"
                        }
                    }).then(async (response) => {
                        if (!response.ok) {
                            throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
                        }
                        const { data } = await response.json();
                        return Array.isArray(data?.locations) ? data.locations : [];
                    })
                );
            }

            const pages = await Promise.all(pagePromises);
            const locations = pages.flat();

            const normalizeAddressText = (text) => {
                const lower = (text || '').toLowerCase();
                return lower
                    .replace(/[^a-z0-9\s]/g, ' ')
                    // Normalize common street suffix abbreviations
                    .replace(/\bst\b/g, 'street')
                    .replace(/\bste\b/g, 'suite')
                    .replace(/\bave\b/g, 'avenue')
                    .replace(/\brd\b/g, 'road')
                    .replace(/\bdr\b/g, 'drive')
                    .replace(/\bblvd\b/g, 'boulevard')
                    .replace(/\bct\b/g, 'court')
                    .replace(/\bln\b/g, 'lane')
                    .replace(/\bpkwy\b/g, 'parkway')
                    .replace(/\bter\b/g, 'terrace')
                    .replace(/\bcir\b/g, 'circle')
                    .replace(/\bctr\b/g, 'center')
                    .replace(/\bapt\b/g, 'apartment')
                    .replace(/\s+/g, ' ')
                    .trim();
            };

            const normalizedQuery = normalizeAddressText(addressQuery);
            const dropNoiseTokens = (text) =>
                text
                    .split(' ')
                    .filter(Boolean)
                    // Remove suite/unit and street suffix tokens that often vary in speech/transcription
                    .filter(
                        (token) =>
                            ![
                                'suite', 'unit', 'apartment', 'floor',
                                'street', 'avenue', 'road', 'drive', 'boulevard',
                                'court', 'lane', 'parkway', 'terrace', 'circle',
                                'center'
                            ].includes(token)
                    )
                    .join(' ');
            const extractPostal = (text) => {
                const match = (text || '').match(/\b\d{5}\b/);
                return match ? match[0] : null;
            };
            const computeTokenOverlap = (a, b) => {
                const aTokens = new Set((a || '').split(' ').filter(Boolean));
                const bTokens = new Set((b || '').split(' ').filter(Boolean));
                if (aTokens.size === 0 || bTokens.size === 0) return 0;
                let intersection = 0;
                aTokens.forEach((token) => {
                    if (bTokens.has(token)) intersection += 1;
                });
                return intersection / aTokens.size;
            };
            const queryCore = dropNoiseTokens(normalizedQuery);
            const queryPostal = extractPostal(normalizedQuery);

            return locations.filter((location) => {
                if (!location?.address) return false;
                const fullAddress = `${location.address.street} ${location.address.city} ${location.address.state} ${location.address.postalCode}`;
                const normalizedAddress = normalizeAddressText(fullAddress);
                const normalizedStreet = normalizeAddressText(location.address.street || '');
                const addressCore = dropNoiseTokens(normalizedAddress);
                const streetCore = dropNoiseTokens(normalizedStreet);
                const tokenOverlap = Math.max(
                    computeTokenOverlap(queryCore, addressCore),
                    computeTokenOverlap(queryCore, streetCore)
                );
                const locationPostal = extractPostal(normalizedAddress);
                const postalMatches = Boolean(queryPostal && locationPostal && queryPostal === locationPostal);
                const strongLegacyIncludes =
                    normalizedAddress.includes(normalizedQuery) ||
                    normalizedQuery.includes(normalizedStreet);

                return (
                    strongLegacyIncludes ||
                    (postalMatches && tokenOverlap >= 0.5) ||
                    tokenOverlap >= 0.8
                );
            });
        } catch (error) {
            console.error('Error searching locations by address from ServiceTrade:', error);
            throw error;
        }
    }



    /**
     * EVERY customer location, unfiltered — the raw GET /location list, one request
     * per page, including those with no phone at all.
     *
     * getLocations() below drops any location without `phoneNumber` or
     * `primaryContact.phone`, which silently loses a site whose only number is on
     * `primaryContact.mobile` or `.alternatePhone`. The phone index needs all four
     * fields, so it needs the raw list.
     */
    async getAllLocations(authToken) {
        const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
        const headers = { Cookie: cookieValue, 'Content-Type': 'application/json' };

        const fetchPage = async (page) => {
            const response = await fetch(`${this.baseUrl}/location?page=${page}&limit=1000`, { method: 'GET', headers });
            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
            }
            const { data } = await response.json();
            return data || {};
        };

        const first = await fetchPage(1);
        const totalPages = first.totalPages || 1;
        if (totalPages <= 1) return first.locations || [];

        const rest = await Promise.all(
            Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2))
        );
        return [first.locations || [], ...rest.map((d) => d.locations || [])].flat();
    }

    async getLocations(authToken) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            
            // Fetch first page to get totalPages
            const firstResponse = await fetch(`${this.baseUrl}/location?page=1&limit=1000`, {
                method: "GET",
                headers: {
                    "Cookie": cookieValue,
                    "Content-Type": "application/json"
                }
            });

            if (!firstResponse.ok) {
                throw new Error(`ServiceTrade API error: ${firstResponse.status} ${firstResponse.statusText}`);
            }

            const { data: firstPageData } = await firstResponse.json();
            const totalPages = firstPageData.totalPages || 1;
            
            console.log(`📊 Fetching ${totalPages} pages of locations in parallel (limit=1000 per page)...`);
            
            // Fetch ALL pages in parallel (including first page again for simplicity)
            const pagePromises = [];
            for (let page = 1; page <= totalPages; page++) {
                pagePromises.push(
                    fetch(`${this.baseUrl}/location?page=${page}&limit=1000`, {
                        method: "GET",
                        headers: {
                            "Cookie": cookieValue,
                            "Content-Type": "application/json"
                        }
                    }).then(async (response) => {
                        if (!response.ok) {
                            throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
                        }
                        const { data } = await response.json();
                        return data.locations || [];
                    })
                );
            }
            
            // Wait for all pages to complete in parallel
            const allPages = await Promise.all(pagePromises);
            
            // Flatten all locations from all pages
            const allLocations = allPages.flat();
            if (allLocations.length > 0) {
                return allLocations.filter((location) => {
                    if (!location) return false;
                    const primaryPhone = location.primaryContact?.phone || '';
                    const locationPhone = location.phoneNumber || '';
                    return primaryPhone.length > 0 || locationPhone.length > 0;
                });
            }
            return [];
        } catch (error) {
            console.error('Error fetching locations from ServiceTrade:', error);
            throw error;
        }
    }
    async getJobs(authToken, locationId, status) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const response = await fetch(`${this.baseUrl}/job?locationId=${locationId}&${status}=true`, {
                method: "GET",
                headers: {
                    "Cookie": cookieValue,
                    "Content-Type": "application/json"
                }
            });

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
            }

            const {data} = await response.json();
            console.log('data: ', JSON.stringify(data.jobs));
            
            return data.jobs;
        } catch (error) {
            console.error('Error fetching jobs from ServiceTrade:', error);
            throw error;
        }
    }

    async getLocationById(authToken, locationId) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const response = await fetch(`${this.baseUrl}/location/${locationId}`, {
                method: "GET",
                headers: {
                    "Cookie": cookieValue,
                    "Content-Type": "application/json"
                }
            });

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText}`);
            }

            const { data } = await response.json();
            return data?.location || data;
        } catch (error) {
            console.error('Error fetching location by ID from ServiceTrade:', error);
            throw error;
        }
    }



    async createJob(authToken, locationId, jobData) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const basePayload = {
                locationId: locationId,
                type: jobData.type || 'Service Call',
                description: jobData.description,
                customName: jobData.customName || 'After Hours Service Call'
            };

            if (jobData.vendorId) {
                basePayload.vendorId = jobData.vendorId;
            }

            // Set primary contact if provided (the person who called)
            if (jobData.primaryContactId) {
                basePayload.primaryContactId = jobData.primaryContactId;
            }

            if (jobData.dueBy) {
                basePayload.dueBy = new Date(jobData.dueBy).getTime() / 1000;
            }

            const postJob = async (payload) => {
                console.log('Creating job with payload:', JSON.stringify(payload));
                const response = await fetch(`${this.baseUrl}/job`, {
                    method: "POST",
                    headers: {
                        "Cookie": cookieValue,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(payload)
                });
                const responseText = await response.text();
                console.log('Job creation response:', response.status, responseText);
                return { response, responseText };
            };

            let { response, responseText } = await postJob(basePayload);

            // Fallback: if ServiceTrade rejects the supplied vendorId as not-found,
            // retry once without vendorId so a stale/wrong config does not block job creation.
            if (!response.ok && basePayload.vendorId) {
                let isVendorIdError = false;
                try {
                    const parsed = JSON.parse(responseText);
                    isVendorIdError = Boolean(parsed?.messages?.validation?.vendorId);
                } catch (_) { /* not JSON, leave false */ }

                if (isVendorIdError) {
                    console.warn(`⚠️ vendorId ${basePayload.vendorId} rejected by ServiceTrade; retrying without vendorId`);
                    const { vendorId, ...payloadWithoutVendor } = basePayload;
                    ({ response, responseText } = await postJob(payloadWithoutVendor));
                }
            }

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText} - ${responseText}`);
            }

            const responseData = JSON.parse(responseText);
            return responseData.data?.job || responseData.job || responseData.data || responseData;
        } catch (error) {
            console.error('Error creating job in ServiceTrade:', error);
            throw error;
        }
    }

    async updateJob(authToken, jobId, jobData) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const response = await fetch(`${this.baseUrl}/job/${jobId}`, {
                method: "PUT",
                headers: {
                    "Cookie": cookieValue,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(jobData)
            });

            const responseText = await response.text();
            console.log('Job update response:', response.status, responseText);

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText} - ${responseText}`);
            }

            const responseData = JSON.parse(responseText);
            return responseData.data?.job || responseData.job || responseData.data || responseData;
        } catch (error) {
            console.error('Error updating job in ServiceTrade:', error);
            throw error;
        }
    }

    async createServiceRequest(authToken, serviceRequestData) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            
            const payload = {
                description: serviceRequestData.description || 'Service request',
                locationId: serviceRequestData.locationId.toString(), // Convert to string
                serviceLineId: serviceRequestData.serviceLineId?.toString() || '1' // Use provided serviceLineId or default to 1
            };

            // Add jobId and appointmentIds if provided
            if (serviceRequestData.jobId) {
                payload.jobId = serviceRequestData.jobId.toString(); // Convert to string
            }
            if (serviceRequestData.appointmentIds && serviceRequestData.appointmentIds.length > 0) {
                // Convert appointment IDs to strings
                payload.appointmentIds = serviceRequestData.appointmentIds.map(id => id.toString());
            }

            console.log('Creating service request with payload:', JSON.stringify(payload));

            const response = await fetch(`${this.baseUrl}/servicerequest`, {
                method: "POST",
                headers: {
                    "Cookie": cookieValue,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            const responseText = await response.text();
            console.log('Service request creation response:', response.status, responseText);

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText} - ${responseText}`);
            }

            const responseData = JSON.parse(responseText);
            return responseData.data?.serviceRequest || responseData.serviceRequest || responseData.data || responseData;
        } catch (error) {
            console.error('Error creating service request in ServiceTrade:', error);
            throw error;
        }
    }

    async createAppointment(authToken, appointmentData) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const payload = {
                jobId: appointmentData.jobId,
                windowStart: appointmentData.windowStart,
                windowEnd: appointmentData.windowEnd,
                techIds: appointmentData.techIds || [],
                serviceRequestIds: appointmentData.serviceRequestIds || [],
                released: appointmentData.released !== undefined ? appointmentData.released : true
            };

            console.log('Creating appointment with payload:', JSON.stringify(payload));

            const response = await fetch(`${this.baseUrl}/appointment`, {
                method: "POST",
                headers: {
                    "Cookie": cookieValue,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            const responseText = await response.text();
            console.log('Appointment creation response:', response.status, responseText);

            if (!response.ok) {
                throw new Error(`ServiceTrade API error: ${response.status} ${response.statusText} - ${responseText}`);
            }

            const responseData = JSON.parse(responseText);
            return responseData.data?.appointment || responseData.appointment || responseData.data || responseData;
        } catch (error) {
            console.error('Error creating appointment in ServiceTrade:', error);
            throw error;
        }
    }


    /**
     * Check whether a stored PHPSESSID is still live, and say why when it is not.
     *
     * The status codes below were read off the live API on 2026-09-11, because the old
     * comment ("401 expired") was wrong in a way that mattered:
     *
     *   GET /api/auth, dead session     -> 404 {"messages":{"error":["No active session found
     *                                          for given auth token"]},"data":{"authenticated":false,...}}
     *   GET /api/location, dead session -> 401, empty body
     *   POST /api/auth, wrong password  -> 403 {"messages":{"error":["Invalid credentials provided"]}}
     *
     * So the expiry signal on THIS endpoint is 404, not 401. Code that only looked for "401"
     * never recognised an expired session for what it was.
     *
     * `data.authenticated` is checked as well as the status: a 200 only proves ServiceTrade
     * answered, and that flag is the field saying the cookie still maps to a user.
     *
     * Anything else - 5xx, a timeout, a DNS failure - returns `expired: false`. That
     * distinction is the point: a ServiceTrade outage must not read as "the session died",
     * or every blip burns a login and throws away a perfectly good token.
     *
     * @returns {Promise<{valid: boolean, expired: boolean, status: number|null, reason: string|null}>}
     */
    async checkSession(authToken) {
        const token = (authToken || '').trim();
        if (!token) {
            return { valid: false, expired: true, status: null, reason: 'no auth_token stored' };
        }

        try {
            const response = await fetch(`${this.baseUrl}/auth`, {
                method: 'GET',
                headers: {
                    'Cookie': `PHPSESSID=${token}`,
                    'Content-Type': 'application/json'
                }
            });

            const body = await response.json().catch(() => null);
            const serverMessage = body?.messages?.error?.join('; ') || null;

            if (response.ok && body?.data?.authenticated !== false) {
                return { valid: true, expired: false, status: response.status, reason: null };
            }

            if ([401, 403, 404].includes(response.status) || body?.data?.authenticated === false) {
                return {
                    valid: false,
                    expired: true,
                    status: response.status,
                    reason: serverMessage || `${response.status} ${response.statusText}`.trim()
                };
            }

            return {
                valid: false,
                expired: false,
                status: response.status,
                reason: serverMessage || `${response.status} ${response.statusText}`.trim()
            };
        } catch (error) {
            console.error('Error validating ServiceTrade session:', error);
            return { valid: false, expired: false, status: null, reason: error.message };
        }
    }

    /**
     * Boolean form of checkSession, so existing callers are unaffected.
     */
    async validateSession(authToken) {
        const { valid } = await this.checkSession(authToken);
        return valid;
    }

    /**
     * Log in to ServiceTrade and return a fresh PHPSESSID.
     *
     * The session id is taken from the response BODY (`data.authToken`) first and from
     * Set-Cookie only as a fallback. Both carry the same value - checked against all five
     * credentialed accounts on 2026-09-11 - but Set-Cookie is the fragile one: any proxy or
     * fetch implementation that drops it turned a successful login into
     * "no PHPSESSID found in Set-Cookie header", and the account then sat expired until a
     * person noticed. The body field is documented and survives that.
     */
    async reAuthenticate(username, password) {
        const response = await fetch(`${this.baseUrl}/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const raw = await response.text().catch(() => '');
        let body = null;
        try { body = JSON.parse(raw); } catch { /* non-JSON body; reported verbatim below */ }

        if (!response.ok) {
            // 403 "Invalid credentials provided" is the wrong-password case. It never fixes
            // itself by retrying, so ServiceTrade's own wording is carried into the alert.
            const detail = body?.messages?.error?.join('; ') || raw.slice(0, 200);
            throw new Error(
                `ServiceTrade re-auth failed: ${response.status} ${response.statusText} ${detail}`.trim()
            );
        }

        const fromBody = body?.data?.authToken;
        const fromCookie = (response.headers.get('set-cookie') || '').match(/PHPSESSID=([^;]+)/)?.[1];
        // Trimmed: one live row is stored with a trailing newline, which then travels into the
        // Cookie header of every subsequent request.
        const token = String(fromBody || fromCookie || '').trim();

        if (!token) {
            throw new Error('ServiceTrade re-auth returned 200 but carried no auth token in the body or Set-Cookie');
        }
        return token;
    }
}
module.exports = new ServiceTradeService();
