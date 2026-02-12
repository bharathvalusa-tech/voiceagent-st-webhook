class ServiceTradeService {
    constructor() {
        this.baseUrl = 'https://api.servicetrade.com/api';
    }

    async getVendorInfo(authToken) {
        try {
            const cookieValue = `PHPSESSID=${authToken}; Path=/; Secure; HttpOnly;`;
            const response = await fetch(`${this.baseUrl}/vendor`, {
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
            return data.vendor || data;
        } catch (error) {
            console.error('Error fetching vendor info from ServiceTrade:', error);
            throw error;
        }
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
            
            const { data } = await response.json();
            return data.contacts.length>0 ? data.contacts[0] : null;
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
                `${this.baseUrl}/location?name=${encodeURIComponent(nameQuery)}&limit=100&status=active`,
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
                `${this.baseUrl}/location?companyId=${companyIdsParam}&status=active&limit=1000`,
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
            // Address matching must scan all active locations, not only page 1.
            const firstResponse = await fetch(
                `${this.baseUrl}/location?page=1&status=active&limit=1000`,
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
                    fetch(`${this.baseUrl}/location?page=${page}&status=active&limit=1000`, {
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
            const payload = {
                locationId: locationId,
                vendorId: jobData.vendorId,
                type: jobData.type || 'Service Call',
                description: jobData.description,
                customName: jobData.customName || 'After Hours Service Call'
            };

            // Set primary contact if provided (the person who called)
            if (jobData.primaryContactId) {
                payload.primaryContactId = jobData.primaryContactId;
            }

            if (jobData.dueBy) {
                payload.dueBy = new Date(jobData.dueBy).getTime() / 1000;
            }

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


}
module.exports = new ServiceTradeService();
