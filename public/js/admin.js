    let deleteCallback = null;
    let allEntries = [];
    let allEmployees = [];
    let currentPeriodOffset = 0; // 0 = current period, -1 = previous, etc.

    function formatHoursDisplay(decimalHours) {
      const h = Math.floor(decimalHours);
      const m = Math.round((decimalHours - h) * 60);
      return `${h}:${String(m).padStart(2, '0')} / ${decimalHours.toFixed(2)}`;
    }

    function fmtAmt(val) {
      return parseFloat(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // Set default dates (LA timezone aware)
    function getLADate() {
      const now = new Date();
      return new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    }

    // Pay period helper functions
    function getPayPeriod(date) {
      const d = new Date(date);
      const year = d.getFullYear();
      const month = d.getMonth();
      const day = d.getDate();

      if (day <= 15) {
        // First half: 1st to 15th
        return {
          start: new Date(year, month, 1),
          end: new Date(year, month, 15)
        };
      } else {
        // Second half: 16th to end of month
        const lastDay = new Date(year, month + 1, 0).getDate();
        return {
          start: new Date(year, month, 16),
          end: new Date(year, month, lastDay)
        };
      }
    }

    function getPayPeriodByOffset(offset = 0) {
      const today = getLADate();
      let targetDate = new Date(today);

      // Move by pay periods
      for (let i = 0; i < Math.abs(offset); i++) {
        if (offset < 0) {
          // Go back
          const currentPeriod = getPayPeriod(targetDate);
          targetDate = new Date(currentPeriod.start);
          targetDate.setDate(targetDate.getDate() - 1);
        } else {
          // Go forward
          const currentPeriod = getPayPeriod(targetDate);
          targetDate = new Date(currentPeriod.end);
          targetDate.setDate(targetDate.getDate() + 1);
        }
      }

      return getPayPeriod(targetDate);
    }

    function formatDateForDB(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    function formatPeriodDisplay(start, end) {
      const options = { month: 'short', day: 'numeric' };
      const startStr = start.toLocaleDateString('en-US', options);
      const endStr = end.toLocaleDateString('en-US', { ...options, year: 'numeric' });
      return `${startStr} - ${endStr}`;
    }

    function changePayPeriod(direction) {
      currentPeriodOffset += direction;
      updatePeriodDisplay();
      loadReviewEntries();
    }

    function updatePeriodDisplay() {
      const period = getPayPeriodByOffset(currentPeriodOffset);
      document.getElementById('period-dates-display').textContent = formatPeriodDisplay(period.start, period.end);

      if (currentPeriodOffset === 0) {
        document.getElementById('period-label-display').textContent = 'Current Pay Period';
      } else if (currentPeriodOffset === -1) {
        document.getElementById('period-label-display').textContent = 'Previous Pay Period';
      } else if (currentPeriodOffset < -1) {
        document.getElementById('period-label-display').textContent = `${Math.abs(currentPeriodOffset)} Periods Ago`;
      } else {
        document.getElementById('period-label-display').textContent = 'Future Pay Period';
      }

      // Disable next button if we're at current period (can't go to future)
      document.getElementById('next-period-btn').disabled = currentPeriodOffset >= 0;
    }

    const today = getLADate();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);

    document.getElementById('report-start').valueAsDate = thirtyDaysAgo;
    document.getElementById('report-end').valueAsDate = today;

    document.getElementById('admin-password').addEventListener('keypress', e => {
      if (e.key === 'Enter') adminLogin();
    });

    async function adminLogin() {
      const password = document.getElementById('admin-password').value;
      const errorEl = document.getElementById('login-error');

      try {
        const response = await fetch('/api/admin/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });

        const data = await response.json();

        if (data.success) {
          sessionStorage.setItem('adminAuth', 'true');
          sessionStorage.setItem('adminPasswordValue', password);
          showScreen('admin-screen');
          updatePeriodDisplay();
          loadEmployeesForFilter();
          loadReviewEntries();
          loadEmployees();
        } else {
          errorEl.classList.add('show');
          document.getElementById('admin-password').value = '';
        }
      } catch (error) {
        errorEl.textContent = 'Connection error';
        errorEl.classList.add('show');
      }
    }

    function adminLogout() {
      sessionStorage.removeItem('adminAuth');
      sessionStorage.removeItem('adminPasswordValue');
      showScreen('login-screen');
      document.getElementById('admin-password').value = '';
    }

    function showScreen(screenId) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById(screenId).classList.add('active');
    }

    function showTab(tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');

      event.target.classList.add('active');
      document.getElementById('tab-' + tabId).style.display = 'block';

      if (tabId === 'review-entries') loadReviewEntries();
      if (tabId === 'employees') loadEmployees();
      if (tabId === 'reports') loadReport();
      if (tabId === 'payments') { populatePaymentsFilter(); loadPayments(); }
      if (tabId === 'tax') loadTaxFilings();
      if (tabId === 'compliance') loadComplianceDashboard();
      if (tabId === 'bank-integration') loadBankIntegration();
    }

    async function loadEmployeesForFilter() {
      try {
        const response = await fetch('/api/admin/employees', {
          headers: { 'x-admin-password': sessionStorage.getItem('adminPasswordValue') || '' },
        });
        allEmployees = await response.json();

        const select = document.getElementById('filter-employee');
        select.innerHTML = '<option value="">All Team Members</option>' +
          allEmployees.map(emp => `<option value="${emp.id}">${escapeHtml(emp.name)}</option>`).join('');
      } catch (error) {
        console.error('Error loading employees for filter:', error);
      }
    }

    async function loadReviewEntries() {
      // Get the pay period based on current offset
      const period = getPayPeriodByOffset(currentPeriodOffset);
      const startDate = formatDateForDB(period.start);
      const endDate = formatDateForDB(period.end);
      const employeeId = document.getElementById('filter-employee').value;

      let url = '/api/admin/time-entries';
      const params = [];
      params.push(`startDate=${startDate}`);
      params.push(`endDate=${endDate}`);
      if (employeeId) params.push(`employeeId=${employeeId}`);
      url += '?' + params.join('&');

      try {
        const response = await fetch(url);
        allEntries = await response.json();

        // Sort entries by date descending (most recent first)
        allEntries.sort((a, b) => new Date(b.date) - new Date(a.date));

        const tbody = document.getElementById('review-entries-table');
        const footer = document.getElementById('review-entries-footer');

        if (allEntries.length === 0) {
          tbody.innerHTML = '<tr><td colspan="11" class="empty-state">No entries found</td></tr>';
          footer.style.display = 'none';
        } else {
          let totalHours = 0;
          let totalWages = 0;
          let totalServiceComm = 0;
          let totalSalesComm = 0;
          let totalTips = 0;
          let totalCashTips = 0;
          let totalPayouts = 0;
          let totalPayable = 0;

          // Fetch payouts for the current period/employee filter
          const period = getPayPeriodByOffset(currentPeriodOffset);
          const startDate = formatDateForDB(period.start);
          const endDate = formatDateForDB(period.end);
          const employeeId = document.getElementById('filter-employee').value;
          let payoutsByEmployee = {};
          try {
            const adminPassword = sessionStorage.getItem('adminPasswordValue') || '';
            let payoutsUrl = `/api/admin/payments?start_date=${startDate}&end_date=${endDate}`;
            if (employeeId) payoutsUrl += `&employee_id=${employeeId}`;
            const payoutsResp = await fetch(payoutsUrl, { headers: { 'x-admin-password': adminPassword } });
            const payoutsData = await payoutsResp.json();
            if (Array.isArray(payoutsData)) {
              payoutsData.forEach(p => {
                const key = `${p.employee_id}_${p.payment_date}`;
                payoutsByEmployee[key] = (payoutsByEmployee[key] || 0) + parseFloat(p.amount || 0);
              });
            }
          } catch (e) {
            // Non-fatal — payouts column will show $0.00
          }

          tbody.innerHTML = allEntries.map(entry => {
            const hours = parseFloat(entry.hours) || 0;
            const wages = hours * (parseFloat(entry.hourly_wage) || 0);
            let serviceComm = 0;
            let tips = 0;
            let cashTips = 0;
            let salesComm = 0;

            if (entry.clients && entry.clients.length > 0) {
              entry.clients.forEach(c => {
                serviceComm += parseFloat(c.amount_earned) || 0;
                tips += parseFloat(c.tip_amount) || 0;
                if (c.tip_received_cash) {
                  cashTips += parseFloat(c.tip_amount) || 0;
                }
              });
            }

            if (entry.productSales && entry.productSales.length > 0) {
              entry.productSales.forEach(p => {
                salesComm += parseFloat(p.commission_amount) || 0;
              });
            }

            const payoutKey = `${entry.employee_id}_${entry.date}`;
            const dayPayouts = payoutsByEmployee[payoutKey] || 0;
            const dayTotal = wages + serviceComm + salesComm + tips - cashTips - dayPayouts;

            totalHours += hours;
            totalWages += wages;
            totalServiceComm += serviceComm;
            totalSalesComm += salesComm;
            totalTips += tips;
            totalCashTips += cashTips;
            totalPayouts += dayPayouts;
            totalPayable += dayTotal;

            const hasDetails = (entry.clients && entry.clients.length > 0) || (entry.productSales && entry.productSales.length > 0);

            return `
              <tr>
                <td><strong>${formatDate(entry.date)}</strong></td>
                <td>${escapeHtml(entry.employee_name)}</td>
                <td style="text-align: right;">${formatHoursDisplay(hours)}</td>
                <td style="text-align: right;">$${fmtAmt(wages)}</td>
                <td style="text-align: right;">$${fmtAmt(serviceComm)}</td>
                <td style="text-align: right;">$${fmtAmt(salesComm)}</td>
                <td style="text-align: right;">$${fmtAmt(tips)}</td>
                <td style="text-align: right; color: #ff6b6b;">${cashTips > 0 ? '-$' + fmtAmt(cashTips) : '$0.00'}</td>
                <td style="text-align: right; color: #ff6b6b;">${dayPayouts > 0 ? '-$' + fmtAmt(dayPayouts) : '$0.00'}</td>
                <td style="text-align: right; color: #6bff6b; font-weight: 600;">$${fmtAmt(dayTotal)}</td>
                <td class="actions">
                  ${hasDetails ? `<button class="btn-secondary" onclick="showEntryDetails(${entry.id})">Details</button>` : ''}
                  <button class="btn-danger" onclick="confirmDeleteEntry(${entry.id})">Delete</button>
                </td>
              </tr>
            `;
          }).join('');

          // Update footer totals
          document.getElementById('review-total-hours').innerHTML = `<strong>${formatHoursDisplay(totalHours)}</strong>`;
          document.getElementById('review-total-wages').innerHTML = `<strong>$${fmtAmt(totalWages)}</strong>`;
          document.getElementById('review-total-service').innerHTML = `<strong>$${fmtAmt(totalServiceComm)}</strong>`;
          document.getElementById('review-total-sales').innerHTML = `<strong>$${fmtAmt(totalSalesComm)}</strong>`;
          document.getElementById('review-total-tips').innerHTML = `<strong>$${fmtAmt(totalTips)}</strong>`;
          document.getElementById('review-total-cash').innerHTML = `<strong>-$${fmtAmt(totalCashTips)}</strong>`;
          document.getElementById('review-total-payouts').innerHTML = `<strong>-$${fmtAmt(totalPayouts)}</strong>`;
          document.getElementById('review-total-payable').innerHTML = `<strong>$${fmtAmt(totalPayable)}</strong>`;
          footer.style.display = '';
        }
      } catch (error) {
        console.error('Error loading review entries:', error);
      }
    }

    function showEntryDetails(entryId) {
      const entry = allEntries.find(e => e.id === entryId);
      if (!entry) return;

      const hourlyEarnings = entry.hours * (entry.hourly_wage || 0);
      let serviceEarnings = 0;
      let tips = 0;
      let tipsOwed = 0;
      let salesCommissions = 0;

      let servicesHtml = '';
      if (entry.clients && entry.clients.length > 0) {
        servicesHtml = '<div style="margin-top: 16px;"><strong style="color: #999; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;">Services & Tips:</strong>';
        entry.clients.forEach(c => {
          serviceEarnings += c.amount_earned || 0;
          tips += c.tip_amount || 0;
          if (!c.tip_received_cash) tipsOwed += c.tip_amount || 0;

          const tipStatus = c.tip_received_cash
            ? '<span class="tip-cash">Cash</span>'
            : '<span class="tip-owed">Owed</span>';

          servicesHtml += `
            <div class="patient-detail">
              <div class="patient-row">
                <span><strong style="color: #999; font-size: 10px;">PATIENT:</strong> ${escapeHtml(c.client_name)}</span>
                <span><strong style="color: #999; font-size: 10px;">SERVICES:</strong> ${escapeHtml(c.procedure_name || '-')}</span>
              </div>
              <div class="patient-row">
                <span>Earned: $${fmtAmt(c.amount_earned)}</span>
                <span>Tip: $${fmtAmt(c.tip_amount)} ${tipStatus}</span>
              </div>
            </div>
          `;
        });
        servicesHtml += '</div>';
      }

      let salesHtml = '';
      if (entry.productSales && entry.productSales.length > 0) {
        salesHtml = '<div style="margin-top: 16px;"><strong style="color: #999; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;">Sales:</strong>';
        entry.productSales.forEach(p => {
          salesCommissions += p.commission_amount || 0;
          salesHtml += `
            <div class="patient-detail">
              <div class="patient-row">
                <span><strong>${escapeHtml(p.product_name)}</strong></span>
                <span>Sale: $${fmtAmt(p.sale_amount)}</span>
              </div>
              <div class="patient-row">
                <span>Commission: $${fmtAmt(p.commission_amount)}</span>
              </div>
            </div>
          `;
        });
        salesHtml += '</div>';
      }

      const totalEarnings = hourlyEarnings + serviceEarnings + tips + salesCommissions;

      const detailsHtml = `
        <div style="margin-bottom: 16px; color: #ccc; line-height: 1.8;">
          <strong style="color: #999; font-size: 11px; letter-spacing: 0.05em;">TEAM MEMBER:</strong> ${escapeHtml(entry.employee_name)}<br>
          <strong style="color: #999; font-size: 11px; letter-spacing: 0.05em;">DATE:</strong> ${formatDate(entry.date)}<br>
          <strong style="color: #999; font-size: 11px; letter-spacing: 0.05em;">TIME:</strong> ${entry.start_time ? formatTime(entry.start_time) : '-'} - ${entry.end_time ? formatTime(entry.end_time) : '-'}<br>
          <strong style="color: #999; font-size: 11px; letter-spacing: 0.05em;">BREAK:</strong> ${entry.break_minutes || 0} minutes<br>
          <strong style="color: #999; font-size: 11px; letter-spacing: 0.05em;">HOURS:</strong> ${entry.hours.toFixed(2)}
        </div>
        ${servicesHtml}
        ${salesHtml}
        <div style="margin-top: 16px; padding: 16px; background: #1a2a1a; border: 1px solid #2a4a2a;">
          <strong style="color: #6bff6b; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;">Earnings Breakdown:</strong><br><br>
          <span style="color: #ccc;">Hourly Pay: $${fmtAmt(hourlyEarnings)}</span><br>
          <span style="color: #ccc;">Service Earnings: $${fmtAmt(serviceEarnings)}</span><br>
          <span style="color: #ccc;">Sales Commissions: $${fmtAmt(salesCommissions)}</span><br>
          <span style="color: #ccc;">Tips: $${fmtAmt(tips)} ${tipsOwed > 0 ? `<span style="color: #ff6b6b;">(${fmtAmt(tipsOwed)} owed)</span>` : ''}</span><br><br>
          <strong style="font-size: 18px; font-family: 'Cormorant Garamond', serif;">Total: $${fmtAmt(totalEarnings)}</strong>
        </div>
        ${entry.description ? `<div style="margin-top: 12px; color: #999;"><strong style="font-size: 11px; letter-spacing: 0.05em;">NOTES:</strong> ${escapeHtml(entry.description)}</div>` : ''}
      `;

      document.getElementById('entry-details-content').innerHTML = detailsHtml;
      document.getElementById('details-modal').classList.add('show');
    }

    function closeDetailsModal() {
      document.getElementById('details-modal').classList.remove('show');
    }

    async function loadEmployees() {
      try {
        const password = sessionStorage.getItem('adminPasswordValue');
        const [empRes, docsRes] = await Promise.all([
          fetch('/api/admin/employees', { headers: { 'x-admin-password': password } }),
          fetch('/api/admin/employee-documents/all', { headers: { 'x-admin-password': password } }),
        ]);
        const employees = await empRes.json();
        const allDocs = docsRes.ok ? await docsRes.json() : [];

        window._employeesCache = employees;

        // Group docs by employee_id for O(1) lookup
        const docsByEmployee = {};
        allDocs.forEach((d) => {
          if (!docsByEmployee[d.employee_id]) docsByEmployee[d.employee_id] = [];
          docsByEmployee[d.employee_id].push(d);
        });

        // Sort: active first (alpha), inactive at bottom (alpha)
        const sorted = [...employees].sort((a, b) => {
          const aInactive = a.status === 'inactive' ? 1 : 0;
          const bInactive = b.status === 'inactive' ? 1 : 0;
          if (aInactive !== bInactive) return aInactive - bInactive;
          return (a.name || '').localeCompare(b.name || '');
        });

        const tbody = document.getElementById('employees-table');

        if (sorted.length === 0) {
          tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No team members yet</td></tr>';
        } else {
          tbody.innerHTML = sorted
            .map((emp) => {
              const inactive = emp.status === 'inactive';
              const buttonBaseStyle = 'background:none;border:none;font-size:17px;cursor:pointer;padding:4px 6px;';
              const editBtnStyle = buttonBaseStyle + 'color:#c9a84c;';
              const delBtnStyle = buttonBaseStyle + 'color:#c9474f;';
              const empNameEsc = escapeHtml(emp.name);

              // Response Form cell — blank for inactive
              let onboardingCell;
              if (inactive) {
                onboardingCell = '<span style="color:#333;font-size:11px;">—</span>';
              } else if (emp.review_completed_at) {
                onboardingCell = `
                  <span style="display:inline-block;background:#0a2a0a;color:#6bff6b;font-size:10px;font-weight:600;padding:3px 10px;border-radius:3px;letter-spacing:0.06em;">ACKNOWLEDGED</span>
                  <br><button class="btn-secondary" style="font-size:10px;padding:2px 8px;margin-top:4px;" onclick="copyResponseFormLink('${emp.review_token}')">Copy Link</button>
                `;
              } else if (emp.review_token) {
                onboardingCell = `
                  <span style="display:inline-block;background:#2a1f00;color:#c9a84c;font-size:10px;font-weight:600;padding:3px 10px;border-radius:3px;letter-spacing:0.06em;">PENDING</span>
                  <br><button class="btn-secondary" style="font-size:10px;padding:2px 8px;margin-top:4px;" onclick="openSendLink(${emp.id})">Send Link</button>
                  <button class="btn-secondary" style="font-size:10px;padding:2px 8px;margin-top:4px;margin-left:4px;" onclick="copyResponseFormLink('${emp.review_token}')">Copy</button>
                `;
              } else {
                onboardingCell = '<span style="color:#555;font-size:11px;">—</span>';
              }

              // Status badge
              const statusCell = inactive
                ? '<span style="font-size:10px;background:#2a1a1a;color:#c9474f;padding:2px 7px;border-radius:2px;letter-spacing:0.04em;">INACTIVE</span>'
                : '<span style="font-size:10px;background:#0a2a0a;color:#6bff6b;padding:2px 7px;border-radius:2px;letter-spacing:0.04em;">ACTIVE</span>';

              // Job type
              const jobType = emp.contractor_type === 'employee' ? 'Employee' : 'Contractor';

              // Compliance cell — blank for inactive, icon for active
              let complianceCell;
              if (inactive) {
                complianceCell = '<span style="color:#333;font-size:11px;">—</span>';
              } else {
                const empDocs = docsByEmployee[emp.id] || [];
                const byType = {};
                empDocs.forEach((d) => {
                  if (!byType[d.document_type]) byType[d.document_type] = [];
                  byType[d.document_type].push(d);
                });
                const required = requiredDocTypes(emp.designation || '');
                const allCompliant = required.every((t) => isItemCompliant(t, byType));
                complianceCell = allCompliant
                  ? `<span onclick="editEmployee(${emp.id})" title="Compliant — click to review" style="color:#6bff6b;font-size:12px;font-weight:700;cursor:pointer;display:block;text-align:center;">Yes</span>`
                  : `<span onclick="editEmployee(${emp.id})" title="Not compliant — click to review" style="color:#ff6b6b;font-size:12px;font-weight:700;cursor:pointer;display:block;text-align:center;">No</span>`;
              }

              return `
              <tr style="${inactive ? 'opacity:0.55;' : ''}">
                <td>
                  <a href="javascript:void(0)" onclick="editEmployee(${emp.id})" style="color:#c9a84c;font-weight:600;text-decoration:none;cursor:pointer;">${escapeHtml(emp.name)}</a>
                </td>
                <td style="font-size:12px;color:#aaa;">${emp.email ? escapeHtml(emp.email) : '<span style="color:#444;">—</span>'}</td>
                <td style="font-size:13px;color:#aaa;min-width:130px;letter-spacing:0.02em;">${emp.phone ? escapeHtml(emp.phone) : '<span style="color:#444;">—</span>'}</td>
                <td style="font-size:12px;">${emp.designation ? escapeHtml(emp.designation) : '<span style="color:#444;">—</span>'}</td>
                <td style="font-size:11px;color:#888;">${jobType}</td>
                <td>${statusCell}</td>
                <td style="font-size:11px;line-height:1.6;">${onboardingCell}</td>
                <td style="text-align:center;">${complianceCell}</td>
                <td class="actions" style="white-space:nowrap;">
                  <button title="Edit" onclick="editEmployee(${emp.id})" style="${editBtnStyle}" aria-label="Edit ${empNameEsc}"><span style="display:inline-block;transform:rotate(-45deg);">✏</span></button>
                  <button title="Delete" onclick="confirmDeleteEmployee(${emp.id}, '${empNameEsc}')" style="${delBtnStyle}" aria-label="Delete ${empNameEsc}">×</button>
                </td>
              </tr>
            `;
            })
            .join('');
        }
      } catch (error) {
        console.error('Error loading employees:', error);
      }
    }

    function getPayTypeFromCheckboxes(prefix) {
      const hourly = document.getElementById(`${prefix}-hourly-check`).checked;
      const services = document.getElementById(`${prefix}-services-check`).checked;
      const sales = document.getElementById(`${prefix}-sales-check`).checked;

      if (hourly && services && sales) return 'hourly_all';
      if (hourly && services) return 'hourly_services';
      if (hourly && sales) return 'hourly_sales';
      if (hourly) return 'hourly';
      if (services && sales) return 'commission_all';
      if (services) return 'commission_services';
      if (sales) return 'commission_sales';
      return 'hourly'; // default
    }

    function setCheckboxesFromPayType(prefix, payType) {
      const hourlyCheck = document.getElementById(`${prefix}-hourly-check`);
      const servicesCheck = document.getElementById(`${prefix}-services-check`);
      const salesCheck = document.getElementById(`${prefix}-sales-check`);

      hourlyCheck.checked = ['hourly', 'hourly_services', 'hourly_sales', 'hourly_all'].includes(payType);
      servicesCheck.checked = ['commission_services', 'hourly_services', 'hourly_all', 'commission_all'].includes(payType);
      salesCheck.checked = ['commission_sales', 'hourly_sales', 'hourly_all', 'commission_all'].includes(payType);
    }

    function formatPfPhone(el) {
      const digits = el.value.replace(/\D/g, '').slice(0, 10);
      let formatted = '';
      if (digits.length > 0) formatted = '(' + digits.slice(0, 3);
      if (digits.length >= 3) formatted += ') ';
      if (digits.length > 3) formatted += digits.slice(3, 6);
      if (digits.length >= 6) formatted += '-';
      if (digits.length > 6) formatted += digits.slice(6, 10);
      el.value = formatted;
    }

    // ============ Pre-Form (Add New Team Member) ============

    function openPreForm() {
      document.getElementById('preform-overlay').classList.add('show');
      document.getElementById('preform-fields').style.display = 'block';
      document.getElementById('preform-success').style.display = 'none';
      document.getElementById('preform-error').classList.remove('show');
      // Reset fields
      ['pf-first-name','pf-last-name','pf-email','pf-phone','pf-hourly',
       'pf-additional-pay-rate','pf-rate-notes','pf-start-date'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      document.getElementById('pf-designation').value = '';
      document.getElementById('pf-contractor-type').value = '';
      document.getElementById('pf-hourly-check').checked = true;
      document.getElementById('pf-services-check').checked = false;
      document.getElementById('pf-sales-check').checked = false;
    }

    function closePreForm() {
      document.getElementById('preform-overlay').classList.remove('show');
      loadEmployees();
    }

    function copyPreFormLink() {
      const url = document.getElementById('preform-onboarding-url').value;
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById('preform-copy-btn');
        btn.textContent = 'Copied!';
        btn.style.color = '#6bff6b';
        setTimeout(() => { btn.textContent = 'Copy'; btn.style.color = ''; }, 2000);
      }).catch(() => prompt('Copy this link:', url));
    }

    async function submitPreForm() {
      const firstName = document.getElementById('pf-first-name').value.trim();
      const lastName = document.getElementById('pf-last-name').value.trim();
      const name = [firstName, lastName].filter(Boolean).join(' ');
      // Auto-generate a random 4-digit PIN (can be changed later via Edit)
      const pin = String(Math.floor(1000 + Math.random() * 9000));
      const email = document.getElementById('pf-email').value.trim();
      const phone = document.getElementById('pf-phone').value.trim();
      const designation = document.getElementById('pf-designation').value;
      const contractorType = document.getElementById('pf-contractor-type').value;
      const payType = getPayTypeFromCheckboxes('pf');
      const hourlyWage = parseFloat(document.getElementById('pf-hourly').value) || 0;
      const additionalPayRate = document.getElementById('pf-additional-pay-rate').value.trim();
      const rateNotes = document.getElementById('pf-rate-notes').value.trim();
      const startDate = document.getElementById('pf-start-date').value || null;
      const errorEl = document.getElementById('preform-error');

      errorEl.classList.remove('show');

      if (!firstName || !lastName) {
        errorEl.textContent = 'First name and last name are required';
        errorEl.classList.add('show');
        return;
      }

      try {
        const response = await fetch('/api/admin/employees', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': sessionStorage.getItem('adminPasswordValue') || '',
          },
          body: JSON.stringify({
            name, pin, email, phone, designation, contractorType,
            payType, hourlyWage,
            additionalPayRate: additionalPayRate ? parseFloat(additionalPayRate) : null,
            rateNotes, startDate,
          }),
        });

        const data = await response.json();

        if (data.success) {
          // Show success state
          const link = `${window.location.origin}/onboarding/${data.onboardingToken}`;
          document.getElementById('preform-success-name').textContent = `${name} has been added. Share the response form link below.`;
          document.getElementById('preform-onboarding-url').value = link;
          window._preformEmployeeId = data.id;
          window._preformEmployeeName = firstName;
          window._preformEmployeePhone = phone;
          window._preformEmployeeEmail = email;
          window._preformOnboardingLink = link;

          document.getElementById('preform-fields').style.display = 'none';
          document.getElementById('preform-success').style.display = 'block';
        } else {
          errorEl.textContent = data.message || 'Error creating team member';
          errorEl.classList.add('show');
        }
      } catch (error) {
        errorEl.textContent = 'Connection error';
        errorEl.classList.add('show');
      }
    }

    // ============ Send Link Modal ============

    let _sendLinkType = '';
    let _sendLinkEmployeeId = null;

    function openSendLink(empId) {
      _sendLinkEmployeeId = empId;
      // Find employee from cache
      const emp = (window._employeesCache || []).find(e => e.id === empId);
      const name = emp ? emp.name : (window._preformEmployeeName || 'team member');
      document.getElementById('send-link-subtitle').textContent = `Send response form link to ${name}`;
      document.getElementById('send-link-options').style.display = 'block';
      document.getElementById('send-link-preview-wrap').style.display = 'none';
      document.getElementById('send-link-sent').style.display = 'none';
      document.getElementById('send-link-close-wrap').style.display = 'flex';
      document.getElementById('send-link-modal').classList.add('show');
    }

    function openSendLinkEmail(empId) {
      openSendLink(empId);
      showSendPreview('email');
    }

    function showSendPreview(type) {
      _sendLinkType = type;
      const emp = (window._employeesCache || []).find(e => e.id === _sendLinkEmployeeId);
      const firstName = emp ? (emp.name || '').split(' ')[0] : (window._preformEmployeeName || '');
      const link = emp && emp.review_token
        ? `${window.location.origin}/onboarding/${emp.review_token}`
        : (window._preformOnboardingLink || '');

      let preview = '';
      let label = '';

      if (type === 'sms') {
        label = 'Text Message Preview (from 213-444-2242)';
        preview = [
          `Hi ${firstName}, this is LeMed Spa. Please complete your response form at the`,
          'link below. The form collects your tax, license, insurance, and payment',
          'details — it takes about 10 minutes.',
          '',
          link,
          '',
          'Questions? Reply to this text or call 818-463-3772.'
        ].join('\n');
      } else {
        label = 'Email Preview (from ops@lemedspa.com)';
        const toEmail = emp?.email || window._preformEmployeeEmail || '(no email on file)';
        preview = [
          'Subject: LeMed Spa — Response Form',
          `To: ${toEmail}`,
          'CC: lea@lemedspa.com',
          '',
          '---',
          '',
          `Hi ${firstName} — Welcome to the LeMed Spa family!`,
          '',
          'Please complete our response form, which collects your contact info,',
          'insurance coverage, payment preferences, and other info needed to get you',
          'properly set up in our systems. It also requires you to upload your',
          'government ID and license/insurance info.',
          '',
          'Access it via this link:',
          link,
          '',
          'If you have any questions, please let Lea know or just reply here.',
          '',
          'We look forward to working with you!',
          '',
          'Regards,',
          '',
          'Accounts | Operations',
          'accounts@lemedspa.com | ops@lemedspa.com'
        ].join('\n');
      }

      document.getElementById('send-preview-label').textContent = label;
      document.getElementById('send-preview-body').textContent = preview;
      document.getElementById('send-link-options').style.display = 'none';
      document.getElementById('send-link-preview-wrap').style.display = 'block';
      document.getElementById('send-link-close-wrap').style.display = 'none';
    }

    function backToSendOptions() {
      document.getElementById('send-link-options').style.display = 'block';
      document.getElementById('send-link-preview-wrap').style.display = 'none';
      document.getElementById('send-link-close-wrap').style.display = 'flex';
    }

    async function confirmSendLink() {
      const btn = document.getElementById('send-confirm-btn');
      btn.disabled = true;
      btn.textContent = 'Sending...';

      try {
        const password = sessionStorage.getItem('adminPasswordValue') || '';
        const response = await fetch(`/api/admin/employees/${_sendLinkEmployeeId}/send-link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
          body: JSON.stringify({ type: _sendLinkType }),
        });

        const data = await response.json();

        document.getElementById('send-link-preview-wrap').style.display = 'none';

        if (data.success) {
          document.getElementById('send-sent-msg').textContent = data.message;
          document.getElementById('send-link-sent').style.display = 'block';
        } else {
          document.getElementById('send-sent-msg').textContent = data.message || 'Failed to send';
          document.getElementById('send-sent-msg').style.color = '#ff6b6b';
          document.getElementById('send-link-sent').style.display = 'block';
        }

        document.getElementById('send-link-close-wrap').style.display = 'flex';
      } catch (err) {
        alert('Network error sending link');
      }

      btn.disabled = false;
      btn.textContent = 'Send';
    }

    function closeSendLinkModal() {
      document.getElementById('send-link-modal').classList.remove('show');
      document.getElementById('send-sent-msg').style.color = '';
    }

    let _currentOnboardingData = null;

    function editEmployee(id) {
      const emp = (window._employeesCache || []).find((e) => e.id === id);
      if (!emp) return;
      document.getElementById('edit-emp-id').value = id;
      const nameParts = (emp.name || '').trim().split(/\s+/);
      document.getElementById('edit-emp-first-name').value = nameParts[0] || '';
      document.getElementById('edit-emp-last-name').value = nameParts.slice(1).join(' ') || '';
      document.getElementById('edit-emp-pin').value = emp.pin || '';
      document.getElementById('edit-emp-email').value = emp.email || '';
      document.getElementById('edit-emp-phone').value = emp.phone || '';
      document.getElementById('edit-emp-designation').value = emp.designation || '';
      document.getElementById('edit-emp-contractor-type').value = emp.contractor_type || '';
      document.getElementById('edit-emp-status').value = emp.status || 'active';
      setCheckboxesFromPayType('edit-emp', emp.pay_type || 'hourly');
      document.getElementById('edit-emp-hourly').value = emp.hourly_wage || '';
      document.getElementById('edit-emp-additional-pay-rate').value = emp.additional_pay_rate || '';
      document.getElementById('edit-emp-rate-notes').value = emp.rate_notes || '';
      document.getElementById('edit-emp-zelle-name').value = emp.zelle_name || '';
      document.getElementById('edit-error').classList.remove('show');
      document.getElementById('edit-doc-status').textContent = '';
      document.getElementById('edit-doc-file').value = '';
      document.getElementById('pii-save-status').textContent = '';
      // Clear raw-value fields so previous data doesn't leak
      ['pii-tin_raw', 'pii-bank_routing_raw', 'pii-bank_account_raw'].forEach(
        (id) => (document.getElementById(id).value = ''),
      );
      _currentOnboardingData = null;
      showPiiTab('identity');
      document.getElementById('edit-modal').classList.add('show');
      loadEmployeeDocs(id);
      // Load full profile data async and populate PII tabs
      fetch(`/api/admin/employees/${id}/onboarding`, {
        headers: { 'x-admin-password': sessionStorage.getItem('adminPasswordValue') || '' },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((resp) => {
          const d = resp?.data || {};
          _currentOnboardingData = d;
          const set = (elId, val) => {
            const el = document.getElementById(elId);
            if (el) el.value = val ?? '';
          };
          // Identity
          set('pii-first_name', d.first_name);
          set('pii-last_name', d.last_name);
          set('pii-middle_name', d.middle_name);
          set('pii-preferred_name', d.preferred_name);
          set('pii-mobile_phone', d.mobile_phone);
          set('pii-date_of_birth', d.date_of_birth);
          set('pii-address_street', d.address_street);
          set('pii-address_city', d.address_city);
          set('pii-address_state', d.address_state);
          set('pii-address_zip', d.address_zip);
          set('pii-driver_license_number', d.driver_license_number);
          set('pii-driver_license_state', d.driver_license_state);
          // Tax
          set('pii-tin_type', d.tin_type);
          set('pii-tin_last4_display', d.tin_last4 ? `***-**-${d.tin_last4}` : '');
          set('pii-w9_entity_name', d.w9_entity_name);
          set('pii-w9_tax_classification', d.w9_tax_classification);
          // Insurance
          set('pii-insurer_name', d.insurer_name);
          set('pii-insurance_policy_number', d.insurance_policy_number);
          set('pii-insurance_expiration', d.insurance_expiration);
          set('pii-prof_liability_per_occurrence', d.prof_liability_per_occurrence);
          set('pii-prof_liability_aggregate', d.prof_liability_aggregate);
          // Banking
          set('pii-bank_name', d.bank_name);
          set('pii-bank_account_owner_name', d.bank_account_owner_name);
          set('pii-bank_account_type', d.bank_account_type);
          set('pii-payment_method', d.payment_method);
          set('pii-zelle_contact', d.zelle_contact);
          set('pii-routing_display', d.bank_routing_last4 ? `*****${d.bank_routing_last4}` : '');
          set('pii-account_display', d.bank_account_last4 ? `*****${d.bank_account_last4}` : '');
          renderReadonlyPiiTabs(d);
        })
        .catch(() => {});
    }

    function renderReadonlyPiiTabs(d) {
      if (!d) return;

      // Licenses tab
      const licEl = document.getElementById('pii-licenses-content');
      if (licEl) {
        const lics = Array.isArray(d.professional_licenses) ? d.professional_licenses : [];
        if (lics.length) {
          licEl.innerHTML = lics
            .map(
              (lic, i) =>
                '<div style="padding:8px;background:#0d0d0d;border:1px solid #222;margin-bottom:6px;">' +
                '<div style="font-size:10px;color:#c9a84c;margin-bottom:4px;">LICENSE ' +
                (i + 1) +
                '</div>' +
                '<div style="display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:#ccc;">' +
                '<span><span style="color:#666;">Type:</span> ' +
                escapeHtml((lic.type || '') + (lic.type === 'Other' && lic.type_other ? ' (' + lic.type_other + ')' : '')) +
                '</span>' +
                '<span><span style="color:#666;">Number:</span> ' + escapeHtml(lic.number || '—') + '</span>' +
                '<span><span style="color:#666;">Status:</span> ' + escapeHtml(lic.status || '—') + '</span>' +
                '<span><span style="color:#666;">Expires:</span> ' + escapeHtml(lic.expiration || '—') + '</span>' +
                (lic.license_url
                  ? ' <a href="' + escapeHtml(lic.license_url) + '" target="_blank" style="color:#c9a84c;">Verify ↗</a>'
                  : '') +
                '</div></div>',
            )
            .join('');
        } else {
          licEl.innerHTML = '<span style="color:#555;font-size:12px;">No professional licenses on file.</span>';
        }
      }

      // Contract tab
      const contractEl = document.getElementById('pii-contract-content');
      if (contractEl) {
        const commitmentLabels = {
          under_15: 'Less than 15 hrs / 1-2 days',
          '15_to_25': '15–25 hrs / 2–3 days',
          '25_to_35': '25–35 hrs / 3–4 days',
          over_35: '35+ hrs / 4+ days',
        };
        const row = (label, val) =>
          val != null && val !== ''
            ? '<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid #111;">' +
              '<span style="font-size:11px;color:#666;min-width:150px;flex-shrink:0;">' + label + '</span>' +
              '<span style="font-size:12px;color:#ccc;">' + escapeHtml(String(val)) + '</span>' +
              '</div>'
            : '';
        const submittedAt = d.review_submitted_at
          ? new Date(d.review_submitted_at).toLocaleString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
            })
          : null;
        const html =
          row('Signature', d.attestation_signature) +
          row('Signature Date', d.attestation_date) +
          row('Desired Time Commitment', commitmentLabels[d.time_commitment_bucket] || d.time_commitment_bucket) +
          row('Other Commitments', d.other_commitments) +
          row('Submitted', submittedAt);
        contractEl.innerHTML = html || '<span style="color:#555;font-size:12px;">No contract submission on file.</span>';
      }
    }

    function showPiiTab(name) {
      ['identity', 'tax', 'insurance', 'banking', 'licenses', 'contract'].forEach((t) => {
        document.getElementById(`pii-panel-${t}`).style.display = t === name ? '' : 'none';
        const btn = document.getElementById(`pii-tab-${t}`);
        btn.classList.toggle('pii-tab-active', t === name);
      });
      // Re-render read-only tabs in case data arrived after last render
      if ((name === 'licenses' || name === 'contract') && _currentOnboardingData) {
        renderReadonlyPiiTabs(_currentOnboardingData);
      }
    }

    async function savePiiData() {
      const id = document.getElementById('edit-emp-id').value;
      const statusEl = document.getElementById('pii-save-status');
      statusEl.style.color = '#888';
      statusEl.textContent = 'Saving…';

      const val = (elId) => document.getElementById(elId)?.value?.trim() ?? '';

      const payload = {};
      const fields = [
        'first_name', 'last_name', 'middle_name', 'preferred_name', 'mobile_phone',
        'date_of_birth', 'address_street', 'address_city', 'address_state', 'address_zip',
        'driver_license_number', 'driver_license_state',
        'tin_type', 'w9_entity_name', 'w9_tax_classification',
        'insurer_name', 'insurance_policy_number', 'insurance_expiration',
        'prof_liability_per_occurrence', 'prof_liability_aggregate',
        'bank_name', 'bank_account_owner_name', 'bank_account_type',
        'payment_method', 'zelle_contact',
      ];
      fields.forEach((f) => {
        const v = val(`pii-${f}`);
        if (v !== '') payload[f] = v;
      });
      const tinRaw = val('pii-tin_raw');
      if (tinRaw) payload.tin_raw = tinRaw;
      const routingRaw = val('pii-bank_routing_raw');
      if (routingRaw) payload.bank_routing_raw = routingRaw;
      const accountRaw = val('pii-bank_account_raw');
      if (accountRaw) payload.bank_account_raw = accountRaw;

      try {
        const res = await fetch(`/api/admin/employees/${id}/pii`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-password': sessionStorage.getItem('adminPasswordValue') || '',
          },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.success) {
          statusEl.style.color = '#6bff6b';
          statusEl.textContent = 'Saved ✓';
          // Clear raw fields after save
          document.getElementById('pii-tin_raw').value = '';
          document.getElementById('pii-bank_routing_raw').value = '';
          document.getElementById('pii-bank_account_raw').value = '';
        } else {
          statusEl.style.color = '#ff6b6b';
          statusEl.textContent = data.message || 'Save failed';
        }
      } catch {
        statusEl.style.color = '#ff6b6b';
        statusEl.textContent = 'Network error';
      }
    }

    const CLINICAL_DESIGNATIONS = new Set([
      'Esthetician',
      'Medical Assistant',
      'Aesthetic Nurse',
      'Aesthetic Nurse Practitioner',
      'Physician',
    ]);

    const DOC_TYPE_META = {
      w9: { label: 'Tax Info / W-9', hasExpiry: false, hasLicenseNo: false },
      driver_license: { label: "Driver's License / Gov ID", hasExpiry: false, hasLicenseNo: false },
      nda: { label: 'Non-Disclosure Agreement', hasExpiry: false, hasLicenseNo: false },
      professional_license: { label: 'Active Professional License', hasExpiry: true, hasLicenseNo: true },
      insurance: { label: 'Insurance Certificate', hasExpiry: true, hasLicenseNo: false },
      contract: { label: 'Contractor Agreement', hasExpiry: false, hasLicenseNo: false },
      other: { label: 'Other', hasExpiry: false, hasLicenseNo: false },
    };

    const MANUAL_COMPLIANCE_ITEMS = [
      {
        key: 'professional_license_verified',
        label: 'Active Professional License',
        clearLabel: 'Mark Verified',
      },
      {
        key: 'disciplinary_actions',
        label: 'Disciplinary actions or concerns?',
        clearLabel: 'Mark Reviewed',
      },
      {
        key: 'liability_current',
        label: 'Current professional liability coverage',
        clearLabel: 'Mark Verified',
      },
      {
        key: 'liability_adequate',
        label: 'Adequate professional liability coverage (250K+ occurrence, 1M+ aggregate)',
        clearLabel: 'Mark Verified',
      },
    ];

    function renderTeammateResponses(o) {
      if (!o) return '<span style="color:#444;font-size:12px;">No onboarding submission on file.</span>';

      function row(label, val) {
        if (val === null || val === undefined || val === '') return '';
        return `<div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px solid #1a1a1a;">
          <span style="font-size:10px;color:#666;min-width:140px;flex-shrink:0;">${label}</span>
          <span style="font-size:11px;color:#bbb;">${escapeHtml(String(val))}</span>
        </div>`;
      }
      function section(title) {
        return `<div style="font-size:9px;color:#c9a84c;letter-spacing:0.12em;text-transform:uppercase;margin:10px 0 4px;padding-bottom:2px;border-bottom:1px solid #222;">${title}</div>`;
      }

      let profLicensesHtml = '';
      if (o.professional_licenses && o.professional_licenses.length > 0) {
        o.professional_licenses.forEach((lic, i) => {
          const licType = lic.type === 'Other' ? `Other (${lic.type_other || ''})` : lic.type;
          profLicensesHtml += row(`License ${i + 1} Type`, licType);
          profLicensesHtml += row(`License ${i + 1} #`, lic.number);
          profLicensesHtml += row(`License ${i + 1} Status`, lic.status);
          profLicensesHtml += row(`License ${i + 1} Expires`, lic.expiration);
        });
      }

      const completedAt = o.submitted_at
        ? new Date(o.submitted_at).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : '';

      const commitmentLabels = {
        under_15: 'Less than 15 hrs / 1-2 days',
        '15_to_25': '15-25 hrs / 2-3 days',
        '25_to_35': '25-35 hrs / 3-4 days',
        over_35: '35+ hrs / 4+ days',
      };

      return `<div style="max-height:320px;overflow-y:auto;padding-right:4px;">
        ${section('Identity')}
        ${row('First Name', o.first_name)}
        ${row('Last Name', o.last_name)}
        ${row('Date of Birth', o.date_of_birth)}
        ${row('Mobile Phone', o.mobile_phone)}
        ${section('Address')}
        ${row('Street', o.address_street)}
        ${row('City', o.address_city)}
        ${row('State', o.address_state)}
        ${row('ZIP', o.address_zip)}
        ${section('Tax / W-9')}
        ${row('TIN Type', o.tin_type)}
        ${row('TIN (last 4)', o.tin_last4 ? `***-**-${o.tin_last4}` : '')}
        ${row('Classification', o.w9_tax_classification)}
        ${section("Driver's License")}
        ${row('DL Number', o.driver_license_number)}
        ${row('DL State', o.driver_license_state)}
        ${section('Professional Licenses')}
        ${profLicensesHtml || '<span style="font-size:11px;color:#444;">None provided</span>'}
        ${o.certifications ? section('Certifications') + row('Certifications', o.certifications) : ''}
        ${section('Professional Liability Insurance')}
        ${row('Insurance Co.', o.insurer_name)}
        ${row('Policy #', o.insurance_policy_number)}
        ${row('Expires', o.insurance_expiration)}
        ${row('Per Occurrence', o.prof_liability_per_occurrence)}
        ${row('Aggregate', o.prof_liability_aggregate)}
        ${section('Banking')}
        ${row('Bank Name', o.bank_name)}
        ${row('Account Owner', o.bank_account_owner_name)}
        ${row('Account Type', o.bank_account_type)}
        ${row('Payment Method', o.payment_method)}
        ${row('Routing (last 4)', o.bank_routing_last4 ? `*****${o.bank_routing_last4}` : '')}
        ${row('Account (last 4)', o.bank_account_last4 ? `*****${o.bank_account_last4}` : '')}
        ${row('Zelle Contact', o.zelle_contact)}
        ${section('Contract & Attestation')}
        ${row('Time Commitment', commitmentLabels[o.time_commitment_bucket] || o.time_commitment_bucket)}
        ${row('Other Commitments', o.other_commitments)}
        ${row('Signature', o.attestation_signature)}
        ${row('Signed', o.attestation_checked ? 'Yes' : o.attestation_checked === false ? 'No' : '')}
        ${row('Signature Date', o.attestation_date)}
        ${row('Submitted', completedAt)}
      </div>`;
    }

    function requiredDocTypes(designation) {
      const base = ['w9', 'driver_license', 'nda'];
      return CLINICAL_DESIGNATIONS.has(designation) ? [...base, 'insurance'] : base;
    }

    function expiryBadge(dateStr) {
      if (!dateStr) return '';
      const exp = new Date(dateStr);
      const days = Math.floor((exp - new Date()) / 86400000);
      const fmt = exp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      if (days < 0)
        return `<span style="background:#3d0000;color:#ff6b6b;font-size:10px;padding:2px 7px;border-radius:2px;white-space:nowrap;flex-shrink:0;">EXPIRED ${fmt}</span>`;
      if (days <= 30)
        return `<span style="background:#3d1a00;color:#ff9f43;font-size:10px;padding:2px 7px;border-radius:2px;white-space:nowrap;flex-shrink:0;">EXP ${fmt}</span>`;
      if (days <= 90)
        return `<span style="background:#2d2a00;color:#f9ca24;font-size:10px;padding:2px 7px;border-radius:2px;white-space:nowrap;flex-shrink:0;">EXP ${fmt}</span>`;
      return `<span style="background:#003d0f;color:#6bff6b;font-size:10px;padding:2px 7px;border-radius:2px;white-space:nowrap;flex-shrink:0;">EXP ${fmt}</span>`;
    }

    function isItemCompliant(type, byType) {
      const docs =
        type === 'nda'
          ? [...(byType['nda'] || []), ...(byType['contract'] || [])]
          : byType[type] || [];
      if (!docs.length) return false;
      const meta = type === 'nda' ? { hasExpiry: false } : DOC_TYPE_META[type] || {};
      if (!meta.hasExpiry) return true;
      return docs.some((d) => !d.expiration_date || new Date(d.expiration_date) >= new Date());
    }

    function renderComplianceDocs(designation, docs, employeeId, complianceItems, professionalLicenses) {
      const required = requiredDocTypes(designation);
      const byType = {};
      docs.forEach((d) => {
        if (!byType[d.document_type]) byType[d.document_type] = [];
        byType[d.document_type].push(d);
      });

      const compByKey = {};
      (complianceItems || []).forEach((c) => {
        compByKey[c.item_key] = c;
      });

      const consumedTypes = new Set(required);
      const allCompliant = required.every((t) => isItemCompliant(t, byType));

      const statusBadge = allCompliant
        ? `<span style="background:#003d0f;color:#6bff6b;font-size:10px;font-weight:600;padding:3px 10px;letter-spacing:0.06em;border-radius:2px;">COMPLIANT</span>`
        : `<span style="background:#3d0000;color:#ff6b6b;font-size:10px;font-weight:600;padding:3px 10px;letter-spacing:0.06em;border-radius:2px;">NOT COMPLIANT</span>`;

      let html = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span style="font-size:10px;color:#666;letter-spacing:0.08em;">REQUIREMENTS</span>
        ${statusBadge}
      </div>`;

      required.forEach((type) => {
        const isNda = type === 'nda';
        const docsForSlot = isNda
          ? [...(byType['nda'] || []), ...(byType['contract'] || [])]
          : byType[type] || [];
        if (isNda) consumedTypes.add('contract');

        const meta = isNda
          ? { label: 'Signed NDA / Contract', hasExpiry: false, hasLicenseNo: false }
          : DOC_TYPE_META[type] || { label: type };

        const compliant = isItemCompliant(type, byType);
        const checkColor = compliant ? '#6bff6b' : '#c9474f';
        const borderColor = compliant ? '#2d6a2d' : '#6a2d2d';
        const symbol = compliant ? '✓' : '✗';

        // Inline submitted license info from onboarding form (professional_license slot only)
        const profLicInfo =
          type === 'professional_license' && professionalLicenses && professionalLicenses.length
            ? professionalLicenses
                .map(
                  (lic) =>
                    `<div style="margin-top:4px;padding:6px 8px;background:#111;border:1px solid #1e2a1e;font-size:11px;color:#aaa;display:flex;flex-wrap:wrap;gap:8px;">` +
                    `<span><span style="color:#555;">Type:</span> ${escapeHtml(lic.type || '—')}</span>` +
                    `<span><span style="color:#555;">#:</span> ${escapeHtml(lic.number || '—')}</span>` +
                    `<span><span style="color:#555;">Status:</span> ${escapeHtml(lic.status || '—')}</span>` +
                    `<span><span style="color:#555;">Expires:</span> ${escapeHtml(lic.expiration || '—')}</span>` +
                    (lic.license_url
                      ? `<a href="${escapeHtml(lic.license_url)}" target="_blank" style="color:#c9a84c;text-decoration:none;">Verify ↗</a>`
                      : '') +
                    `</div>`,
                )
                .join('')
            : '';

        if (!docsForSlot.length) {
          html += `<div style="padding:8px 10px;background:#0d0d0d;border:1px solid #2a2a2a;border-left:3px solid ${borderColor};margin-bottom:4px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:13px;color:${checkColor};flex-shrink:0;">${symbol}</span>
              <span style="font-size:12px;color:#aaa;flex:1;">${escapeHtml(meta.label)}</span>
              <span style="font-size:10px;color:#555;flex-shrink:0;">No document on file</span>
              <button onclick="focusUploadForType('${isNda ? 'nda' : type}')" style="font-size:10px;color:#c9a84c;background:none;border:1px solid #333;padding:2px 8px;cursor:pointer;flex-shrink:0;">+ Upload</button>
            </div>
            ${profLicInfo}
          </div>`;
        } else {
          docsForSlot.forEach((d, idx) => {
            const licLine =
              meta.hasLicenseNo && d.license_number
                ? `<span style="font-size:10px;color:#888;white-space:nowrap;flex-shrink:0;">#${escapeHtml(d.license_number)}</span>`
                : '';
            html += `<div style="padding:8px 10px;background:#0d0d0d;border:1px solid #2a2a2a;border-left:3px solid ${borderColor};margin-bottom:4px;">
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:13px;color:${checkColor};flex-shrink:0;">${symbol}</span>
                <span style="font-size:12px;color:#ccc;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(d.file_name || d.file_path)}">${escapeHtml(meta.label)}</span>
                ${licLine}
                ${expiryBadge(d.expiration_date)}
                ${d.url ? `<a href="${d.url}" target="_blank" style="font-size:11px;color:#c9a84c;text-decoration:none;flex-shrink:0;">View</a>` : ''}
                <button onclick="deleteEmployeeDoc(${d.id}, ${employeeId})" style="background:none;border:none;color:#c9474f;font-size:16px;cursor:pointer;padding:0 4px;flex-shrink:0;" title="Delete">×</button>
              </div>
              ${idx === 0 ? profLicInfo : ''}
            </div>`;
          });
        }
      });

      const additionalTypes = Object.keys(byType).filter((t) => !consumedTypes.has(t));
      if (additionalTypes.length) {
        html +=
          '<div style="font-size:10px;color:#666;letter-spacing:0.08em;margin-top:14px;margin-bottom:8px;">ADDITIONAL DOCUMENTS</div>';
        additionalTypes.forEach((type) => {
          const meta = DOC_TYPE_META[type] || { label: type };
          byType[type].forEach((d) => {
            html += `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#0d0d0d;border:1px solid #2a2a2a;margin-bottom:4px;">
              <span style="font-size:10px;background:#1a1a2e;color:#6b9fff;padding:2px 7px;border-radius:2px;white-space:nowrap;flex-shrink:0;">${escapeHtml(meta.label)}</span>
              <span style="font-size:12px;color:#ccc;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(d.file_name || d.file_path)}">${escapeHtml(d.file_name || d.file_path)}</span>
              ${expiryBadge(d.expiration_date)}
              ${d.url ? `<a href="${d.url}" target="_blank" style="font-size:11px;color:#c9a84c;text-decoration:none;flex-shrink:0;">View</a>` : ''}
              <button onclick="deleteEmployeeDoc(${d.id}, ${employeeId})" style="background:none;border:none;color:#c9474f;font-size:16px;cursor:pointer;padding:0 4px;flex-shrink:0;" title="Delete">×</button>
            </div>`;
          });
        });
      }

      // Manual compliance items
      if (MANUAL_COMPLIANCE_ITEMS.length) {
        html +=
          '<div style="font-size:10px;color:#666;letter-spacing:0.08em;margin-top:14px;margin-bottom:8px;">MANUAL REVIEW ITEMS</div>';
        MANUAL_COMPLIANCE_ITEMS.forEach((item) => {
          const saved = compByKey[item.key];
          const isCleared = saved?.is_cleared;
          const comment = saved?.comment || '';
          const clearedAt = saved?.cleared_at
            ? new Date(saved.cleared_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : null;
          const borderColor = isCleared ? '#2d6a2d' : '#6a2d2d';
          const checkColor = isCleared ? '#6bff6b' : '#c9474f';
          const symbol = isCleared ? '✓' : '✗';
          html += `<div style="padding:8px 10px;background:#0d0d0d;border:1px solid #2a2a2a;border-left:3px solid ${borderColor};margin-bottom:4px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
              <span style="font-size:13px;color:${checkColor};flex-shrink:0;">${symbol}</span>
              <span style="font-size:12px;color:#aaa;flex:1;">${escapeHtml(item.label)}</span>
              ${isCleared ? `<span style="font-size:10px;color:#555;flex-shrink:0;">Cleared ${clearedAt}</span>` : ''}
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" id="ci-comment-${item.key}-${employeeId}" placeholder="Add comment…" value="${escapeHtml(comment)}"
                style="flex:1;font-size:11px;padding:4px 7px;background:#111;border:1px solid #333;color:#ccc;outline:none;">
              <button onclick="saveComplianceItem(${employeeId},'${item.key}',false)"
                style="font-size:10px;padding:4px 10px;background:none;border:1px solid #444;color:#888;cursor:pointer;white-space:nowrap;">Save Note</button>
              <button onclick="saveComplianceItem(${employeeId},'${item.key}',true)"
                style="font-size:10px;padding:4px 10px;background:#0a2a0a;border:1px solid #2a5a2a;color:#6bff6b;cursor:pointer;white-space:nowrap;">${item.clearLabel}</button>
            </div>
          </div>`;
        });
      }

      return html;
    }

    async function saveComplianceItem(employeeId, key, isCleared) {
      const commentEl = document.getElementById(`ci-comment-${key}-${employeeId}`);
      const comment = commentEl?.value || '';
      const password = sessionStorage.getItem('adminPasswordValue') || '';
      const res = await fetch(`/api/admin/employees/${employeeId}/compliance-items/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ comment, is_cleared: isCleared }),
      });
      if (res.ok) loadEmployeeDocs(employeeId);
    }

    function onDocTypeChange() {
      const type = document.getElementById('edit-doc-type').value;
      const meta = DOC_TYPE_META[type] || {};
      document.getElementById('edit-doc-license-row').style.display = meta.hasLicenseNo ? 'flex' : 'none';
      document.getElementById('edit-doc-expiry-row').style.display = meta.hasExpiry ? 'flex' : 'none';
    }

    function focusUploadForType(type) {
      const sel = document.getElementById('edit-doc-type');
      sel.value = type;
      onDocTypeChange();
      sel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      sel.focus();
    }

    async function loadEmployeeDocs(employeeId) {
      const listEl = document.getElementById('edit-docs-list');
      listEl.innerHTML = '<span style="color:#555;font-size:12px;">Loading…</span>';
      try {
        const password = sessionStorage.getItem('adminPasswordValue') || '';
        const [docsRes, compRes, onbRes] = await Promise.all([
          fetch(`/api/admin/employees/${employeeId}/documents`, { headers: { 'x-admin-password': password } }),
          fetch(`/api/admin/employees/${employeeId}/compliance-items`, { headers: { 'x-admin-password': password } }),
          fetch(`/api/admin/employees/${employeeId}/onboarding`, { headers: { 'x-admin-password': password } }),
        ]);
        const docs = await docsRes.json();
        const complianceItems = compRes.ok ? await compRes.json() : [];
        const onbData = onbRes.ok ? await onbRes.json() : null;
        const professionalLicenses = onbData?.data?.professional_licenses || [];
        const designation = document.getElementById('edit-emp-designation').value;
        listEl.innerHTML = renderComplianceDocs(designation, docs, employeeId, complianceItems, professionalLicenses);
      } catch (e) {
        listEl.innerHTML = '<span style="color:#c9474f;font-size:12px;">Failed to load documents.</span>';
      }
    }

    async function uploadEmployeeDoc() {
      const employeeId = document.getElementById('edit-emp-id').value;
      const docType = document.getElementById('edit-doc-type').value;
      const fileInput = document.getElementById('edit-doc-file');
      const statusEl = document.getElementById('edit-doc-status');

      if (!fileInput.files.length) {
        statusEl.style.color = '#c9474f';
        statusEl.textContent = 'Select a file first.';
        return;
      }

      statusEl.style.color = '#888';
      statusEl.textContent = 'Uploading…';

      const formData = new FormData();
      formData.append('file', fileInput.files[0]);
      formData.append('document_type', docType);
      const expiry = document.getElementById('edit-doc-expiry').value;
      const license = document.getElementById('edit-doc-license').value.trim();
      if (expiry) formData.append('expiration_date', expiry);
      if (license) formData.append('license_number', license);

      try {
        const res = await fetch(`/api/admin/employees/${employeeId}/documents`, {
          method: 'POST',
          headers: { 'x-admin-password': sessionStorage.getItem('adminPasswordValue') || '' },
          body: formData,
        });
        const data = await res.json();
        if (data.success) {
          statusEl.style.color = '#6bff6b';
          statusEl.textContent = 'Uploaded!';
          fileInput.value = '';
          document.getElementById('edit-doc-expiry').value = '';
          document.getElementById('edit-doc-license').value = '';
          loadEmployeeDocs(employeeId);
        } else {
          statusEl.style.color = '#c9474f';
          statusEl.textContent = data.message || 'Upload failed.';
        }
      } catch (e) {
        statusEl.style.color = '#c9474f';
        statusEl.textContent = 'Connection error.';
      }
    }

    async function openSignedDoc(event, filePath) {
      event.preventDefault();
      const password = sessionStorage.getItem('adminPasswordValue') || '';
      try {
        const res = await fetch(`/api/admin/storage/signed-url?path=${encodeURIComponent(filePath)}`, {
          headers: { 'x-admin-password': password },
        });
        const data = await res.json();
        if (data.url) {
          window.open(data.url, '_blank');
        } else {
          alert('Could not generate download link.');
        }
      } catch (e) {
        alert('Error fetching file.');
      }
    }

    async function deleteEmployeeDoc(docId, employeeId) {
      if (!confirm('Remove this document?')) return;
      const res = await fetch(`/api/admin/employee-documents/${docId}`, {
        method: 'DELETE',
        headers: { 'x-admin-password': sessionStorage.getItem('adminPasswordValue') || '' },
      });
      const data = await res.json();
      if (data.success) {
        loadEmployeeDocs(employeeId);
      }
    }

    async function saveEmployee() {
      const id = document.getElementById('edit-emp-id').value;
      const firstName = document.getElementById('edit-emp-first-name').value.trim();
      const lastName = document.getElementById('edit-emp-last-name').value.trim();
      const name = [firstName, lastName].filter(Boolean).join(' ');
      const pin = document.getElementById('edit-emp-pin').value.trim();
      const email = document.getElementById('edit-emp-email').value.trim();
      const phone = document.getElementById('edit-emp-phone').value.trim();
      const designation = document.getElementById('edit-emp-designation').value;
      const contractorType = document.getElementById('edit-emp-contractor-type').value;
      const payType = getPayTypeFromCheckboxes('edit-emp');
      const hourlyWage = parseFloat(document.getElementById('edit-emp-hourly').value) || 0;
      const additionalPayRateVal = document.getElementById('edit-emp-additional-pay-rate').value.trim();
      const rateNotes = document.getElementById('edit-emp-rate-notes').value.trim();
      const zelleName = document.getElementById('edit-emp-zelle-name').value.trim();
      const status = document.getElementById('edit-emp-status').value;
      const errorEl = document.getElementById('edit-error');

      errorEl.classList.remove('show');

      if (!name || !pin) {
        errorEl.textContent = 'Please enter name and PIN';
        errorEl.classList.add('show');
        return;
      }

      if (!/^\d{4}$/.test(pin)) {
        errorEl.textContent = 'PIN must be exactly 4 digits';
        errorEl.classList.add('show');
        return;
      }

      try {
        const response = await fetch(`/api/admin/employees/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            pin,
            email,
            phone,
            designation,
            contractorType,
            payType,
            hourlyWage,
            additionalPayRate: additionalPayRateVal ? parseFloat(additionalPayRateVal) : null,
            rateNotes,
            zelleName,
            status,
          }),
        });

        const data = await response.json();

        if (data.success) {
          closeEditModal();
          loadEmployees();
        } else {
          errorEl.textContent = data.message || 'Error updating employee';
          errorEl.classList.add('show');
        }
      } catch (error) {
        errorEl.textContent = 'Connection error';
        errorEl.classList.add('show');
      }
    }

    function closeEditModal() {
      document.getElementById('edit-modal').classList.remove('show');
    }

    function confirmDeleteEntry(id) {
      document.getElementById('delete-message').textContent = 'Are you sure you want to delete this time entry?';
      deleteCallback = () => deleteEntry(id);
      document.getElementById('delete-modal').classList.add('show');
    }

    function confirmDeleteEmployee(id, name) {
      document.getElementById('delete-message').textContent = `Are you sure you want to delete "${name}"? This will also delete all their time entries.`;
      deleteCallback = () => deleteEmployee(id);
      document.getElementById('delete-modal').classList.add('show');
    }

    async function deleteEntry(id) {
      try {
        await fetch(`/api/admin/time-entries/${id}`, { method: 'DELETE' });
        loadReviewEntries();
        closeDeleteModal();
      } catch (error) {
        console.error('Error deleting entry:', error);
      }
    }

    async function deleteEmployee(id) {
      try {
        await fetch(`/api/admin/employees/${id}`, { method: 'DELETE' });
        loadEmployees();
        closeDeleteModal();
      } catch (error) {
        console.error('Error deleting employee:', error);
      }
    }

    function closeDeleteModal() {
      document.getElementById('delete-modal').classList.remove('show');
      deleteCallback = null;
    }

    document.getElementById('confirm-delete-btn').addEventListener('click', () => {
      if (deleteCallback) deleteCallback();
    });

    async function loadReport() {
      const startDate = document.getElementById('report-start').value;
      const endDate = document.getElementById('report-end').value;

      try {
        let url = '/api/admin/time-entries';
        if (startDate && endDate) {
          url += `?startDate=${startDate}&endDate=${endDate}`;
        }

        const response = await fetch(url);
        const entries = await response.json();

        // Calculate totals
        let totalHours = 0;
        let totalHourlyPay = 0;
        let totalServices = 0;
        let totalSales = 0;
        let totalTips = 0;
        let totalTipsOwed = 0;

        // Group by employee
        const byEmployee = {};

        entries.forEach(e => {
          const empName = e.employee_name;
          if (!byEmployee[empName]) {
            byEmployee[empName] = {
              hours: 0,
              hourlyPay: 0,
              services: 0,
              sales: 0,
              tips: 0,
              tipsOwed: 0,
              hourlyWage: e.hourly_wage || 0
            };
          }

          byEmployee[empName].hours += e.hours;
          const hourlyEarnings = e.hours * (e.hourly_wage || 0);
          byEmployee[empName].hourlyPay += hourlyEarnings;
          totalHourlyPay += hourlyEarnings;
          totalHours += e.hours;

          if (e.clients) {
            e.clients.forEach(c => {
              byEmployee[empName].services += c.amount_earned || 0;
              byEmployee[empName].tips += c.tip_amount || 0;
              totalServices += c.amount_earned || 0;
              totalTips += c.tip_amount || 0;
              if (!c.tip_received_cash) {
                byEmployee[empName].tipsOwed += c.tip_amount || 0;
                totalTipsOwed += c.tip_amount || 0;
              }
            });
          }

          if (e.productSales) {
            e.productSales.forEach(p => {
              byEmployee[empName].sales += p.commission_amount || 0;
              totalSales += p.commission_amount || 0;
            });
          }
        });

        const grandTotal = totalHourlyPay + totalServices + totalSales + totalTips;

        // Render stats
        document.getElementById('report-stats').innerHTML = `
          <div class="stat-card">
            <div class="label">Total Hours</div>
            <div class="value">${totalHours.toFixed(1)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Hourly Pay</div>
            <div class="value">$${totalHourlyPay.toFixed(0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Services</div>
            <div class="value">$${totalServices.toFixed(0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Sales</div>
            <div class="value">$${totalSales.toFixed(0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Tips</div>
            <div class="value">$${totalTips.toFixed(0)}</div>
          </div>
          <div class="stat-card">
            <div class="label">Tips Owed</div>
            <div class="value" style="color: ${totalTipsOwed > 0 ? '#ff6b6b' : '#ffffff'};">$${totalTipsOwed.toFixed(0)}</div>
          </div>
          <div class="stat-card" style="background: #1a2a1a; border-color: #2a4a2a;">
            <div class="label" style="color: #6bff6b;">Grand Total</div>
            <div class="value" style="color: #6bff6b;">$${grandTotal.toFixed(0)}</div>
          </div>
        `;

        // Render table
        const tbody = document.getElementById('report-table');
        const employeeList = Object.entries(byEmployee).sort((a, b) =>
          (b[1].hourlyPay + b[1].services + b[1].sales + b[1].tips) - (a[1].hourlyPay + a[1].services + a[1].sales + a[1].tips)
        );

        if (employeeList.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No data for this period</td></tr>';
        } else {
          tbody.innerHTML = employeeList.map(([name, data]) => {
            const total = data.hourlyPay + data.services + data.sales + data.tips;
            return `
              <tr>
                <td><strong>${escapeHtml(name)}</strong></td>
                <td>${data.hours.toFixed(1)}h</td>
                <td>$${fmtAmt(data.hourlyPay)}</td>
                <td>$${fmtAmt(data.services)}</td>
                <td>$${fmtAmt(data.sales)}</td>
                <td>$${fmtAmt(data.tips)}</td>
                <td style="color: ${data.tipsOwed > 0 ? '#ff6b6b' : '#666'};">$${fmtAmt(data.tipsOwed)}</td>
                <td><span class="earnings-total">$${fmtAmt(total)}</span></td>
              </tr>
            `;
          }).join('');
        }
      } catch (error) {
        console.error('Error loading report:', error);
      }
    }

    function resetToCurrentPeriod() {
      currentPeriodOffset = 0;
      document.getElementById('filter-employee').value = '';
      updatePeriodDisplay();
      loadReviewEntries();
    }

    function formatDate(dateStr) {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function formatTime(timeStr) {
      if (!timeStr) return '';
      const [hours, minutes] = timeStr.split(':');
      const h = parseInt(hours);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 || 12;
      return `${h12}:${minutes} ${ampm}`;
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function copyResponseFormLink(token) {
      const link = `${window.location.origin}/onboarding/${token}`;
      navigator.clipboard.writeText(link).then(() => {
        // Flash feedback
        const btn = event.target;
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.color = '#6bff6b';
        setTimeout(() => {
          btn.textContent = original;
          btn.style.color = '';
        }, 2000);
      }).catch(() => {
        prompt('Copy this link:', link);
      });
    }

    async function viewOnboardingDetails(employeeId) {
      try {
        const password = sessionStorage.getItem('adminPasswordValue') || '';
        const response = await fetch(`/api/admin/employees/${employeeId}/onboarding`, {
          headers: { 'x-admin-password': password }
        });

        if (response.status === 404) {
          alert('No onboarding data found for this employee.');
          return;
        }

        if (!response.ok) {
          alert('Error loading onboarding data.');
          return;
        }

        const data = await response.json();
        const o = data.data;
        if (!o) {
          alert('No onboarding submission found.');
          return;
        }

        const completedAt = o.submitted_at ? new Date(o.submitted_at).toLocaleString('en-US', {
          month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
        }) : '—';

        function row(label, val) {
          if (!val) return '';
          return `<tr><td style="color:#888;font-size:11px;padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top;">${label}</td><td style="color:#ccc;font-size:13px;padding:6px 0;">${escapeHtml(String(val))}</td></tr>`;
        }

        function section(title) {
          return `<tr><td colspan="2" style="padding:16px 0 4px;color:#c9a84c;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;font-weight:600;border-bottom:1px solid #222;">${title}</td></tr>`;
        }

        const tdStyle = 'color:#888;font-size:11px;padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top;';
        const linkTdStyle = 'color:#ccc;font-size:13px;padding:6px 0;';
        const linkStyle = 'color:#c9a84c;';

        // Format professional licenses array for display
        let profLicensesHtml = '';
        if (o.professional_licenses && o.professional_licenses.length > 0) {
          o.professional_licenses.forEach((lic, i) => {
            const licType = lic.type === 'Other' ? `Other (${lic.type_other || ''})` : lic.type;
            profLicensesHtml += row(`License ${i + 1} Type`, licType);
            profLicensesHtml += row(`License ${i + 1} #`, lic.number);
            profLicensesHtml += row(`License ${i + 1} Status`, lic.status);
            profLicensesHtml += row(`License ${i + 1} Expires`, lic.expiration);
            if (lic.license_url) {
              const licUrlHtml = `<tr><td style="${tdStyle}">License ${i + 1} URL</td><td style="${linkTdStyle}"><a href="${escapeHtml(lic.license_url)}" target="_blank" style="${linkStyle}">${escapeHtml(lic.license_url)}</a></td></tr>`;
              profLicensesHtml += licUrlHtml;
            }
          });
        }
        const dlUploadRow = o.driver_license_upload_path
          ? `<tr><td style="${tdStyle}">DL Upload</td><td style="${linkTdStyle}"><a href="#" onclick="openSignedDoc(event,'${escapeHtml(o.driver_license_upload_path)}')" style="${linkStyle}">View file</a></td></tr>`
          : '';
        const insUploadRow = o.insurance_upload_path
          ? `<tr><td style="${tdStyle}">Insurance Cert</td><td style="${linkTdStyle}"><a href="#" onclick="openSignedDoc(event,'${escapeHtml(o.insurance_upload_path)}')" style="${linkStyle}">View file</a></td></tr>`
          : '';

        const html = `
          <table style="width:100%;border-collapse:collapse;margin-top:8px;">
            ${section('Identity')}
            ${row('First Name', o.first_name)}
            ${row('Last Name', o.last_name)}
            ${row('Date of Birth', o.date_of_birth)}
            ${row('Mobile Phone', o.mobile_phone)}
            ${section('Address')}
            ${row('Street', o.address_street)}
            ${row('City', o.address_city)}
            ${row('State', o.address_state)}
            ${row('ZIP', o.address_zip)}
            ${section('Tax (W-9)')}
            ${row('TIN Type', o.tin_type)}
            ${row('TIN (last 4)', o.tin_last4 ? `***-**-${o.tin_last4}` : '')}
            ${row('Classification', o.w9_tax_classification)}
            ${section("Driver's License")}
            ${row("DL Number", o.driver_license_number)}
            ${row("DL State", o.driver_license_state)}
            ${dlUploadRow}
            ${section('Professional Licenses')}
            ${profLicensesHtml || '<tr><td colspan="2" style="color:#555;font-size:12px;padding:6px 0;">None provided</td></tr>'}
            ${o.certifications ? `${section('Certifications')}${row('Certifications', o.certifications)}` : ''}
            ${section('Professional Liability Insurance')}
            ${row('Insurance Co.', o.insurance_company)}
            ${row('Policy #', o.insurance_policy_number)}
            ${row('Insurance Expires', o.insurance_expiration)}
            ${insUploadRow}
            ${section('Banking')}
            ${row('Bank Name', o.bank_name)}
            ${row('Account Owner', o.bank_account_owner_name)}
            ${row('Account Type', o.bank_account_type)}
            ${row('Payment Method', o.payment_method)}
            ${row('Routing (last 4)', o.bank_routing_last4 ? `*****${o.bank_routing_last4}` : '')}
            ${row('Account (last 4)', o.bank_account_last4 ? `*****${o.bank_account_last4}` : '')}
            ${row('Zelle Contact', o.zelle_contact)}
            ${section('Contract & Attestation')}
            ${row('IC Agreement', o.ic_agreement_version)}
            ${row('Signature', o.attestation_signature)}
            ${row('Signature Date', o.attestation_date)}
            ${row('Submitted', completedAt)}
            ${row('IP Address', o.ip_address)}
          </table>
        `;

        document.getElementById('onboarding-details-content').innerHTML = html;
        document.getElementById('onboarding-modal').classList.add('show');
      } catch (error) {
        console.error('Error loading onboarding details:', error);
        alert('Failed to load onboarding details.');
      }
    }

    function closeOnboardingModal() {
      document.getElementById('onboarding-modal').classList.remove('show');
    }

    // ============ Payments Tab ============

    function populatePaymentsFilter() {
      const sel = document.getElementById('payments-filter-employee');
      if (!sel || sel.options.length > 1) return; // already populated
      (window._employeesCache || allEmployees || [])
        .slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .forEach((emp) => {
          const opt = document.createElement('option');
          opt.value = emp.id;
          opt.textContent = emp.name;
          sel.appendChild(opt);
        });
    }

    function clearPaymentsFilter() {
      const empSel = document.getElementById('payments-filter-employee');
      const startIn = document.getElementById('payments-filter-start');
      const endIn = document.getElementById('payments-filter-end');
      if (empSel) empSel.value = '';
      if (startIn) startIn.value = '';
      if (endIn) endIn.value = '';
      loadPayments();
    }

    async function loadPayments() {
      const password = sessionStorage.getItem('adminPasswordValue');
      const employeeId = document.getElementById('payments-filter-employee')?.value || '';
      const startDate = document.getElementById('payments-filter-start')?.value || '';
      const endDate = document.getElementById('payments-filter-end')?.value || '';

      let url = '/api/admin/payments';
      const params = [];
      if (employeeId) params.push(`employee_id=${employeeId}`);
      if (startDate) params.push(`start_date=${startDate}`);
      if (endDate) params.push(`end_date=${endDate}`);
      if (params.length) url += '?' + params.join('&');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, { headers: { 'x-admin-password': password }, signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) {
          const tbody = document.getElementById('payments-table');
          if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="empty-state" style="color:#c9474f;">Error loading payments (${res.status})</td></tr>`;
          return;
        }
        const payments = await res.json();

        const tbody = document.getElementById('payments-table');
        const footer = document.getElementById('payments-footer');
        const totalEl = document.getElementById('payments-total');
        const summaryDiv = document.getElementById('payments-summary');
        const summaryContent = document.getElementById('payments-summary-content');

        if (!payments.length) {
          tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No payments found</td></tr>';
          footer.style.display = 'none';
          summaryDiv.style.display = 'none';
          return;
        }

        let total = 0;
        tbody.innerHTML = payments
          .map((p) => {
            total += parseFloat(p.amount);
            const date = new Date(p.payment_date + 'T00:00:00').toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
            const desc = p.description || '';
            return `
            <tr>
              <td style="font-size:12px;white-space:nowrap;">${date}</td>
              <td style="white-space:nowrap;"><strong>${escapeHtml(p.teammate_name)}</strong></td>
              <td style="text-align:right;font-size:13px;color:#c9a84c;white-space:nowrap;"><strong>$${fmtAmt(p.amount)}</strong></td>
              <td style="font-size:11px;color:#888;white-space:nowrap;">${escapeHtml(p.payment_method || '')}</td>
              <td style="font-size:11px;color:#888;white-space:nowrap;">${escapeHtml(p.source || '')}</td>
              <td style="font-size:11px;color:#666;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(desc)}">${escapeHtml(desc) || '<span style="color:#444;">—</span>'}</td>
              <td style="font-size:11px;color:#777;">${escapeHtml(p.notes || '') || '<span style="color:#444;">—</span>'}</td>
              <td class="actions" style="white-space:nowrap;">
                <button title="Edit" onclick="editPayment(${p.id})" style="background:none;border:none;color:#c9a84c;font-size:17px;cursor:pointer;padding:4px 6px;">✏</button>
                <button title="Delete" onclick="confirmDeletePayment(${p.id}, '${escapeHtml(p.teammate_name)}')" style="background:none;border:none;color:#c9474f;font-size:17px;cursor:pointer;padding:4px 6px;">✕</button>
              </td>
            </tr>`;
          })
          .join('');

        totalEl.innerHTML = `<strong>$${fmtAmt(total)}</strong>`;
        footer.style.display = '';

        // Summary by teammate when showing all
        if (!employeeId) {
          const byTeammate = {};
          payments.forEach((p) => {
            byTeammate[p.teammate_name] = (byTeammate[p.teammate_name] || 0) + parseFloat(p.amount);
          });
          summaryContent.innerHTML = Object.entries(byTeammate)
            .sort((a, b) => b[1] - a[1])
            .map(
              ([name, amt]) =>
                `<div style="text-align:center;padding:8px 16px;"><div style="font-size:11px;color:#888;margin-bottom:2px;">${escapeHtml(name)}</div><div style="font-size:16px;color:#c9a84c;font-weight:600;">$${fmtAmt(amt)}</div></div>`,
            )
            .join('');
          summaryDiv.style.display = '';
        } else {
          summaryDiv.style.display = 'none';
        }
      } catch (err) {
        clearTimeout(timeoutId);
        const tbody = document.getElementById('payments-table');
        if (err.name === 'AbortError') {
          if (tbody)
            tbody.innerHTML = `<tr><td colspan="8" class="empty-state" style="color:#c9474f;">Request timed out — server may be waking up, please try again in a moment.</td></tr>`;
        } else {
          console.error('Error loading payments:', err);
          if (tbody)
            tbody.innerHTML = `<tr><td colspan="8" class="empty-state" style="color:#c9474f;">Failed to load payments. Please refresh and try again.</td></tr>`;
        }
      }
    }

    function populateEmployeeDropdown(empSel) {
      empSel.innerHTML = '<option value="">— Select team member —</option>';
      (window._employeesCache || allEmployees || [])
        .slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .forEach((emp) => {
          const opt = document.createElement('option');
          opt.value = emp.id;
          opt.textContent = emp.name;
          empSel.appendChild(opt);
        });
    }

    async function openPaymentModal(payment) {
      const overlay = document.getElementById('payment-modal-overlay');
      const title = document.getElementById('payment-modal-title');
      const empSel = document.getElementById('payment-employee-select');

      // Show modal immediately — don't block on employee fetch
      overlay.style.display = 'flex';

      // Set form fields
      if (payment) {
        title.textContent = 'Edit Payment';
        document.getElementById('payment-editing-id').value = payment.id;
        document.getElementById('payment-date-input').value = payment.payment_date;
        document.getElementById('payment-amount-input').value = parseFloat(payment.amount).toFixed(2);
        document.getElementById('payment-method-input').value = payment.payment_method || 'Zelle';
        document.getElementById('payment-source-input').value = payment.source || '';
        document.getElementById('payment-notes-input').value = payment.notes || '';
      } else {
        title.textContent = 'Add Payment';
        document.getElementById('payment-editing-id').value = '';
        document.getElementById('payment-date-input').value = new Date().toISOString().slice(0, 10);
        document.getElementById('payment-amount-input').value = '';
        document.getElementById('payment-method-input').value = 'Zelle';
        document.getElementById('payment-source-input').value = 'Chase 7855';
        document.getElementById('payment-notes-input').value = '';
      }

      // Populate employee dropdown — use cache if available, fetch if not
      if (window._employeesCache && window._employeesCache.length > 0) {
        populateEmployeeDropdown(empSel);
        if (payment) empSel.value = payment.employee_id || '';
      } else {
        empSel.innerHTML = '<option value="">Loading...</option>';
        try {
          const res = await fetch('/api/admin/employees', {
            headers: { 'x-admin-password': sessionStorage.getItem('adminPasswordValue') || '' },
          });
          if (res.ok) {
            window._employeesCache = await res.json();
          }
        } catch (e) {
          // leave cache empty; dropdown will show no options
        }
        populateEmployeeDropdown(empSel);
        if (payment) empSel.value = payment.employee_id || '';
      }
    }

    function closePaymentModal() {
      document.getElementById('payment-modal-overlay').style.display = 'none';
    }

    async function savePayment() {
      const password = sessionStorage.getItem('adminPasswordValue');
      const editingId = document.getElementById('payment-editing-id').value;
      const empId = document.getElementById('payment-employee-select').value;
      const date = document.getElementById('payment-date-input').value;
      const amount = parseFloat(document.getElementById('payment-amount-input').value);
      const method = document.getElementById('payment-method-input').value;
      const source = document.getElementById('payment-source-input').value.trim();
      const notes = document.getElementById('payment-notes-input').value.trim();

      if (!empId) return alert('Please select a team member.');
      if (!date) return alert('Please enter a date.');
      if (!amount || amount <= 0) return alert('Please enter a valid amount.');

      const emp = (window._employeesCache || allEmployees || []).find((e) => e.id == empId);
      const teammateName = emp ? emp.name : '';

      const body = { employee_id: parseInt(empId), teammate_name: teammateName, payment_date: date, amount, payment_method: method, source: source || null, notes };

      try {
        let res;
        if (editingId) {
          res = await fetch(`/api/admin/payments/${editingId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
            body: JSON.stringify(body),
          });
        } else {
          res = await fetch('/api/admin/payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
            body: JSON.stringify(body),
          });
        }
        if (!res.ok) throw new Error('Save failed');
        closePaymentModal();
        loadPayments();
      } catch (err) {
        alert('Failed to save payment. Please try again.');
      }
    }

    async function editPayment(id) {
      const password = sessionStorage.getItem('adminPasswordValue');
      const res = await fetch(`/api/admin/payments/${id}`, { headers: { 'x-admin-password': password } });
      if (!res.ok) return alert('Could not load payment.');
      const payment = await res.json();
      openPaymentModal(payment);
    }

    async function confirmDeletePayment(id, name) {
      if (!confirm(`Delete payment to ${name}? This cannot be undone.`)) return;
      const password = sessionStorage.getItem('adminPasswordValue');
      const res = await fetch(`/api/admin/payments/${id}`, { method: 'DELETE', headers: { 'x-admin-password': password } });
      if (!res.ok) return alert('Delete failed.');
      loadPayments();
    }

    async function loadTaxFilings() {
      const password = sessionStorage.getItem('adminPasswordValue');
      const year = document.getElementById('tax-year-filter')?.value || '2025';
      const tbody = document.getElementById('tax-table');
      tbody.innerHTML = '<tr><td colspan="9" style="color:#555;text-align:center;padding:20px;">Loading…</td></tr>';

      try {
        const res = await fetch(`/api/admin/filings-1099?year=${year}`, { headers: { 'x-admin-password': password } });
        if (!res.ok) throw new Error('Failed to load tax filings');
        const filings = await res.json();

        if (!filings.length) {
          tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No 1099 filings for ${year}</td></tr>`;
          document.getElementById('tax-summary-cards').style.display = 'none';
          return;
        }

        // Summary cards
        const totalComp = filings.reduce((s, f) => s + parseFloat(f.box1_nonemployee_comp || 0), 0);
        const tinFailed = filings.filter(f => f.tin_match === 'Failed').length;
        const cardValueStyle = 'font-size:22px;font-weight:700;';
        const cardLabelStyle = 'font-size:11px;color:#666;margin-top:2px;';
        const totalCompFormatted = totalComp.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });
        const summaryCards = `
          <div><div style="${cardValueStyle}color:#c9a84c;">$${totalCompFormatted}</div><div style="${cardLabelStyle}">Total NEC Compensation</div></div>
          <div><div style="${cardValueStyle}color:#e0d8c8;">${filings.length}</div><div style="${cardLabelStyle}">Contractors</div></div>
          ${tinFailed ? `<div><div style="${cardValueStyle}color:#ff6b6b;">${tinFailed}</div><div style="${cardLabelStyle}">TIN Match Failed</div></div>` : ''}
        `;
        document.getElementById('tax-summary-content').innerHTML = summaryCards;
        document.getElementById('tax-summary-cards').style.display = 'block';

        // Table rows
        tbody.innerHTML = filings
          .map(f => {
            const tinMatchCell =
              f.tin_match === 'Failed'
                ? '<span style="color:#ff6b6b;font-size:11px;font-weight:600;">FAILED</span>'
                : '<span style="color:#6bff6b;font-size:11px;">Passed</span>';
            const tinCell = f.tin_last4
              ? `<span style="color:#888;font-size:12px;">···${escapeHtml(f.tin_last4)}</span>`
              : '<span style="color:#444;font-size:11px;">—</span>';
            const comp = parseFloat(f.box1_nonemployee_comp || 0).toLocaleString('en-US', {
              style: 'currency',
              currency: 'USD',
            });
            const irsDate = f.irs_submit_date
              ? new Date(f.irs_submit_date).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : '—';
            const recipDate = f.email_recipient_date
              ? new Date(f.email_recipient_date).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : '—';
            const location = [f.city, f.state].filter(Boolean).join(', ') || '—';
            return `<tr>
            <td style="font-weight:600;">${escapeHtml(f.recipient_name || '—')}</td>
            <td style="font-size:11px;color:#888;">${escapeHtml(f.form || '—')}</td>
            <td style="font-size:12px;">${f.tax_year || '—'}</td>
            <td>${tinCell}</td>
            <td style="text-align:right;font-family:monospace;">${comp}</td>
            <td>${tinMatchCell}</td>
            <td style="font-size:11px;color:#888;">${irsDate}</td>
            <td style="font-size:11px;color:#888;">${recipDate}</td>
            <td style="font-size:11px;color:#666;">${escapeHtml(location)}</td>
          </tr>`;
          })
          .join('');
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="9" style="color:#ff6b6b;text-align:center;padding:20px;">Error: ${escapeHtml(err.message)}</td></tr>`;
      }
    }

    async function loadComplianceDashboard() {
      const password = sessionStorage.getItem('adminPasswordValue');
      const tbody = document.getElementById('compliance-table');
      const summaryEl = document.getElementById('compliance-summary-content');
      tbody.innerHTML =
        '<tr><td colspan="10" style="color:#555;text-align:center;padding:20px;">Loading…</td></tr>';

      try {
        const [empRes, docRes] = await Promise.all([
          fetch('/api/admin/employees', { headers: { 'x-admin-password': password } }),
          fetch('/api/admin/employee-documents/all', { headers: { 'x-admin-password': password } }),
        ]);
        const employees = await empRes.json();
        const allDocs = await docRes.json();

        // Index docs by employee id
        const docsByEmployee = {};
        allDocs.forEach(d => {
          if (!docsByEmployee[d.employee_id]) docsByEmployee[d.employee_id] = [];
          docsByEmployee[d.employee_id].push(d);
        });

        // Active employees only
        const active = employees.filter(e => e.status !== 'inactive');

        // Compute per-employee compliance
        const rows = active.map(emp => {
          const docs = docsByEmployee[emp.id] || [];
          const byType = {};
          docs.forEach(d => {
            if (!byType[d.document_type]) byType[d.document_type] = [];
            byType[d.document_type].push(d);
          });

          const needsInsurance = CLINICAL_DESIGNATIONS.has(emp.designation || '');

          const hasW9 = isItemCompliant('w9', byType);
          const hasId = isItemCompliant('driver_license', byType);
          const hasNda = isItemCompliant('nda', byType);
          const hasInsurance = needsInsurance ? isItemCompliant('insurance', byType) : null;

          // Insurance expiry — prefer doc expiration_date, fall back to emp field
          const insDoc = (byType['insurance'] || []).find(d => d.expiration_date);
          const insExpiry = insDoc?.expiration_date || emp.insurance_expiration || null;

          const responseForm = emp.review_completed_at ? 'done' : emp.review_token ? 'pending' : 'none';

          const allOk =
            hasW9 && hasId && hasNda && (needsInsurance ? hasInsurance : true) && responseForm === 'done';

          return { emp, hasW9, hasId, hasNda, hasInsurance, needsInsurance, insExpiry, responseForm, allOk };
        });

        // Summary counts
        const pending = rows.filter(r => !r.allOk).length;
        const rfPending = rows.filter(r => r.responseForm !== 'done').length;
        const insExpired = rows.filter(r => {
          if (!r.insExpiry) return false;
          return new Date(r.insExpiry) < new Date();
        }).length;
        const insExpiring = rows.filter(r => {
          if (!r.insExpiry) return false;
          const days = Math.floor((new Date(r.insExpiry) - new Date()) / 86400000);
          return days >= 0 && days <= 90;
        }).length;

        summaryEl.innerHTML = `
          <div><div style="font-size:22px;font-weight:700;color:${pending ? '#ff6b6b' : '#6bff6b'};">${pending}</div><div style="font-size:11px;color:#666;margin-top:2px;">Non-Compliant</div></div>
          <div><div style="font-size:22px;font-weight:700;color:#e0d8c8;">${active.length}</div><div style="font-size:11px;color:#666;margin-top:2px;">Active Members</div></div>
          ${rfPending ? `<div><div style="font-size:22px;font-weight:700;color:#c9a84c;">${rfPending}</div><div style="font-size:11px;color:#666;margin-top:2px;">Response Form Pending</div></div>` : ''}
          ${insExpired ? `<div><div style="font-size:22px;font-weight:700;color:#ff6b6b;">${insExpired}</div><div style="font-size:11px;color:#666;margin-top:2px;">Insurance Expired</div></div>` : ''}
          ${insExpiring ? `<div><div style="font-size:22px;font-weight:700;color:#ff9f43;">${insExpiring}</div><div style="font-size:11px;color:#666;margin-top:2px;">Ins. Expiring ≤90 days</div></div>` : ''}
        `;

        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No active team members</td></tr>';
          return;
        }

        // Sort: non-compliant first, then alpha
        rows.sort((a, b) => {
          if (a.allOk !== b.allOk) return a.allOk ? 1 : -1;
          return (a.emp.name || '').localeCompare(b.emp.name || '');
        });

        function checkCell(ok) {
          return ok
            ? '<span style="color:#6bff6b;font-size:14px;">✓</span>'
            : '<span style="color:#ff6b6b;font-size:14px;">✗</span>';
        }

        tbody.innerHTML = rows
          .map(({ emp, hasW9, hasId, hasNda, hasInsurance, needsInsurance, insExpiry, responseForm, allOk }) => {
            const rfCell =
              responseForm === 'done'
                ? '<span style="color:#6bff6b;font-size:11px;font-weight:600;">Done</span>'
                : responseForm === 'pending'
                  ? '<span style="color:#c9a84c;font-size:11px;font-weight:600;">Pending</span>'
                  : '<span style="color:#555;font-size:11px;">Not sent</span>';

            const insCell = needsInsurance
              ? checkCell(hasInsurance)
              : '<span style="color:#333;font-size:11px;">—</span>';

            const insExpiryCell = insExpiry
              ? expiryBadge(insExpiry)
              : needsInsurance
                ? '<span style="color:#ff6b6b;font-size:11px;">Missing</span>'
                : '<span style="color:#333;">—</span>';

            const overallCell = allOk
              ? '<span style="color:#6bff6b;font-size:11px;font-weight:700;">Compliant</span>'
              : '<span style="color:#ff6b6b;font-size:11px;font-weight:700;">Action Needed</span>';

            const canSendReminder = (emp.phone || emp.email) && responseForm !== 'done';
            const actionCell = canSendReminder
              ? `<button class="btn-secondary" style="font-size:10px;padding:3px 10px;white-space:nowrap;" onclick="openSendLink(${emp.id})">Send Reminder</button>`
              : `<button class="btn-secondary" style="font-size:10px;padding:3px 10px;white-space:nowrap;" onclick="editEmployee(${emp.id})">Review</button>`;

            return `<tr style="${allOk ? '' : 'background:rgba(255,50,50,0.03);'}">
            <td><a href="javascript:void(0)" onclick="editEmployee(${emp.id})" style="color:#c9a84c;font-weight:600;text-decoration:none;">${escapeHtml(emp.name || '')}</a></td>
            <td style="font-size:11px;color:#888;">${escapeHtml(emp.designation || '—')}</td>
            <td>${rfCell}</td>
            <td style="text-align:center;">${checkCell(hasW9)}</td>
            <td style="text-align:center;">${checkCell(hasId)}</td>
            <td style="text-align:center;">${checkCell(hasNda)}</td>
            <td style="text-align:center;">${insCell}</td>
            <td>${insExpiryCell}</td>
            <td>${overallCell}</td>
            <td>${actionCell}</td>
          </tr>`;
          })
          .join('');

        loadCOIReview();
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="10" style="color:#ff6b6b;text-align:center;padding:20px;">Error: ${escapeHtml(err.message)}</td></tr>`;
      }
    }

    async function loadCOIReview() {
      const password = sessionStorage.getItem('adminPasswordValue');
      let res;
      try {
        res = await fetch('/api/compliance/review', { headers: { 'x-admin-password': password } });
      } catch {
        return;
      }
      if (!res.ok) return;
      const { items } = await res.json();

      const count = document.getElementById('compliance-count');
      const list = document.getElementById('compliance-list');
      const empty = document.getElementById('compliance-empty');

      if (items.length) {
        count.textContent = `${items.length} pending`;
        count.style.display = '';
      } else {
        count.style.display = 'none';
      }
      list.innerHTML = '';

      if (!items.length) {
        empty.style.display = '';
        return;
      }
      empty.style.display = 'none';

      for (const item of items) {
        const workerEdits = item.worker_edits ? Object.entries(item.worker_edits) : [];
        const editHtml = workerEdits.length
          ? `<div style="background:#1a1500;border:1px solid #4a3a00;border-radius:6px;padding:10px;margin-top:10px;font-size:0.8rem">
               <strong style="color:#e8c46a">⚠ Worker made ${workerEdits.length} edit${workerEdits.length > 1 ? 's' : ''}</strong>
               ${workerEdits
                 .map(
                   ([k, v]) =>
                     `<div style="color:#aaa;margin-top:4px">${k.replace(/_/g, ' ')}: <s style="color:#888">${escapeHtml(String(v.original || ''))}</s> → <span style="color:#e8e8e8">${escapeHtml(String(v.corrected || ''))}</span></div>`,
                 )
                 .join('')}
             </div>`
          : '';

        const card = document.createElement('div');
        card.style.cssText =
          'background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:16px;margin-bottom:16px';
        const itemId = String(item.id);
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
            <div>
              <div class="f-name" style="font-weight:600;font-size:1rem"></div>
              <div style="color:#888;font-size:0.8rem">COI · Confirmed <span class="confirmed-date"></span></div>
            </div>
            <a href="/api/compliance/document-admin/${escapeHtml(itemId)}" target="_blank"
               style="color:#e8c46a;font-size:0.8rem;text-decoration:none">View PDF ↗</a>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.85rem">
            <div><span style="color:#888">Insurer</span><br><strong class="f-insurer">—</strong></div>
            <div><span style="color:#888">Policy #</span><br><strong class="f-policy">—</strong></div>
            <div><span style="color:#888">Expiry</span><br><strong class="f-expiry" style="color:#7ec87e">—</strong></div>
            <div><span style="color:#888">Coverage</span><br><strong class="f-coverage">—</strong></div>
          </div>

          ${editHtml}

          <div style="display:flex;gap:10px;margin-top:14px">
            <button onclick="approveDoc('${escapeHtml(itemId)}')"
              style="flex:2;padding:10px;background:#7ec87e;color:#111;font-weight:700;border:none;border-radius:6px;cursor:pointer">
              ✓ Approve &amp; Update Record
            </button>
            <button onclick="rejectDoc('${escapeHtml(itemId)}')"
              style="flex:1;padding:10px;background:transparent;color:#c87e7e;border:1px solid #c87e7e;border-radius:6px;cursor:pointer">
              ✕ Request New Doc
            </button>
          </div>
        `;

        // Set text content for user data (XSS safe)
        card.querySelector('.f-name').textContent = item.employees.name;
        card.querySelector('.confirmed-date').textContent = new Date(
          item.worker_confirmed_at,
        ).toLocaleDateString();
        card.querySelector('.f-insurer').textContent = item.insurer_name || '—';
        card.querySelector('.f-policy').textContent = item.policy_number || '—';
        card.querySelector('.f-expiry').textContent = item.expiration_date || '—';
        card.querySelector('.f-coverage').textContent = `$${(item.per_occurrence || 0).toLocaleString()} / $${(item.aggregate || 0).toLocaleString()}`;

        list.appendChild(card);
      }
    }

    async function approveDoc(id) {
      if (!confirm('Approve this certificate and update the employee record?')) return;
      const password = sessionStorage.getItem('adminPasswordValue');
      try {
        const res = await fetch(`/api/compliance/review/${id}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
          body: '{}',
        });
        if (res.ok) loadCOIReview();
        else alert('Error approving. Try again.');
      } catch {
        alert('Network error. Check your connection and try again.');
      }
    }

    async function rejectDoc(id) {
      if (!confirm('Reject this document and send worker a new upload link?')) return;
      const password = sessionStorage.getItem('adminPasswordValue');
      try {
        const res = await fetch(`/api/compliance/review/${id}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
          body: '{}',
        });
        if (res.ok) loadCOIReview();
        else alert('Error rejecting. Try again.');
      } catch {
        alert('Network error. Check your connection and try again.');
      }
    }

    // ============================================================
    // Bank Integration — Plaid Link, sync, pending review, auto-imports
    // ============================================================

    function getAdminPassword() {
      return sessionStorage.getItem('adminPasswordValue') || '';
    }

    function adminFetch(url, options = {}) {
      return fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          'x-admin-password': getAdminPassword(),
        },
      });
    }

    function buildPlaidHandler(linkToken, receivedRedirectUri) {
      const btn = document.getElementById('plaid-connect-btn');
      const config = {
        token: linkToken,
        onSuccess: async (publicToken) => {
          btn.disabled = true;
          btn.textContent = 'Connecting...';
          // Clear oauth_state_id from URL so a refresh doesn't re-trigger
          const cleanUrl = window.location.origin + window.location.pathname;
          window.history.replaceState({}, '', cleanUrl);
          const exResp = await adminFetch('/api/admin/plaid/exchange-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicToken }),
          });
          const exData = await exResp.json();
          if (exData.success) {
            document.getElementById('bank-connection-status').textContent = 'Connected ✓';
            document.getElementById('bank-connection-status').style.color = '#6bff6b';
            btn.textContent = 'Reconnect Bank';
            btn.disabled = false;
            loadBankIntegration();
          } else {
            alert('Connection failed: ' + (exData.message || 'Unknown error'));
            btn.disabled = false;
            btn.textContent = 'Connect Bank Account';
          }
        },
        onExit: () => {
          btn.disabled = false;
          btn.textContent = 'Connect Bank Account';
          // Clear oauth params from URL on exit too
          const cleanUrl = window.location.origin + window.location.pathname;
          window.history.replaceState({}, '', cleanUrl);
        },
      };
      if (receivedRedirectUri) config.receivedRedirectUri = receivedRedirectUri;
      return Plaid.create(config);
    }

    // On page load, check if we're returning from OAuth (Chase redirects back here)
    (async function checkOAuthReturn() {
      const params = new URLSearchParams(window.location.search);
      if (!params.has('oauth_state_id')) return;
      // We're returning from OAuth — retrieve the stored link token and re-open Link
      const storedToken = sessionStorage.getItem('plaid_link_token');
      if (!storedToken) return;
      sessionStorage.removeItem('plaid_link_token');
      const receivedRedirectUri = window.location.href;
      const handler = buildPlaidHandler(storedToken, receivedRedirectUri);
      handler.open();
    })();

    async function openPlaidLink() {
      const btn = document.getElementById('plaid-connect-btn');
      btn.disabled = true;
      btn.textContent = 'Loading...';
      try {
        const resp = await adminFetch('/api/admin/plaid/link-token', { method: 'POST' });
        const data = await resp.json();
        if (!data.success) throw new Error(data.message || 'Failed to get Link token');
        // Store token in sessionStorage so the OAuth return flow can retrieve it
        sessionStorage.setItem('plaid_link_token', data.linkToken);
        const handler = buildPlaidHandler(data.linkToken, null);
        handler.open();
      } catch (e) {
        alert('Error: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Connect Bank Account';
      }
    }

    async function runPlaidSync() {
      const btn = document.getElementById('plaid-sync-btn');
      const statusEl = document.getElementById('plaid-sync-status');
      btn.disabled = true;
      btn.textContent = 'Syncing...';
      statusEl.textContent = '';
      try {
        const resp = await adminFetch('/api/admin/plaid/sync', { method: 'POST' });
        const data = await resp.json();
        if (!data.success) throw new Error(data.message || 'Sync failed');
        statusEl.textContent = `Done — ${data.matchedCount} imported, ${data.pendingCount} pending review`;
        statusEl.style.color = '#6bff6b';
        await loadBankIntegration();
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        statusEl.style.color = '#ff6b6b';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sync Now';
      }
    }

    async function loadBankIntegration() {
      await Promise.all([loadPlaidPending(), loadPlaidImports()]);
    }

    async function loadPlaidPending() {
      try {
        const resp = await adminFetch('/api/admin/plaid/pending');
        const data = await resp.json();
        const tbody = document.getElementById('plaid-pending-tbody');
        const table = document.getElementById('plaid-pending-table');
        const empty = document.getElementById('plaid-pending-empty');
        const countEl = document.getElementById('plaid-pending-count');

        if (!data.success || !data.data?.length) {
          table.style.display = 'none';
          empty.style.display = 'block';
          countEl.style.display = 'none';
          return;
        }

        empty.style.display = 'none';
        table.style.display = 'table';
        countEl.textContent = data.data.length;
        countEl.style.display = 'inline';

        const employees = window._employeesCache || [];
        tbody.innerHTML = data.data
          .map(
            (tx) => `<tr>
            <td style="padding:6px 8px;">${tx.transaction_date}</td>
            <td style="padding:6px 8px;text-align:right;">$${fmtAmt(tx.amount)}</td>
            <td style="padding:6px 8px;color:#ccc;">${escapeHtml(tx.description || '')}</td>
            <td style="padding:6px 8px;">
              <select id="pending-assign-${tx.id}" style="width:140px;">
                <option value="">-- Select --</option>
                ${employees.filter((e) => e.status === 'active').map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')}
              </select>
              <input type="text" id="pending-comments-${tx.id}" placeholder="Notes (optional)" style="width:140px;margin-top:4px;font-size:11px;padding:3px 6px;background:#0a0a0a;border:1px solid #333;color:#ccc;border-radius:3px;">
            </td>
            <td style="padding:6px 8px;text-align:center;white-space:nowrap;">
              <button class="btn-primary" style="font-size:11px;padding:3px 10px;" onclick="plaidAssign('${tx.id}')">Assign</button>
              <button class="btn-secondary" style="font-size:11px;padding:3px 10px;margin-left:4px;" onclick="plaidDiscard('${tx.id}')">Discard</button>
            </td>
          </tr>`,
          )
          .join('');
      } catch (e) {
        console.error('loadPlaidPending error:', e);
      }
    }

    async function loadPlaidImports() {
      try {
        const resp = await adminFetch('/api/admin/payments?auto_imported=true&limit=30');
        const raw = await resp.json();
        const tbody = document.getElementById('plaid-imports-tbody');
        const table = document.getElementById('plaid-imports-table');
        const empty = document.getElementById('plaid-imports-empty');

        // Route returns a bare array
        const items = (Array.isArray(raw) ? raw : (raw.data || [])).filter((p) => p.auto_imported);

        if (!items.length) {
          table.style.display = 'none';
          empty.style.display = 'block';
          return;
        }

        empty.style.display = 'none';
        table.style.display = 'table';
        const employees = window._employeesCache || [];

        tbody.innerHTML = items
          .map((p) => {
            const emp = employees.find((e) => e.id === p.employee_id);
            const empName = emp ? escapeHtml(emp.name) : `#${p.employee_id}`;
            const badge = p.auto_imported
              ? `<span style="color:#f0a500;font-size:11px;font-weight:700;">Unverified</span>
              <button class="btn-primary" style="font-size:10px;padding:2px 8px;margin-left:6px;" onclick="plaidVerify(${p.id})">Verify ✓</button>`
              : `<span style="color:#6bff6b;font-size:11px;font-weight:700;">Verified</span>`;
            return `<tr>
              <td style="padding:6px 8px;">${p.payment_date}</td>
              <td style="padding:6px 8px;">${empName}</td>
              <td style="padding:6px 8px;text-align:right;">$${fmtAmt(p.amount)}</td>
              <td style="padding:6px 8px;color:#ccc;">${escapeHtml(p.notes || '')}</td>
              <td style="padding:6px 8px;text-align:center;white-space:nowrap;">
                ${badge}
                ${p.auto_imported ? `<button class="btn-secondary" style="font-size:10px;padding:2px 8px;margin-left:6px;" onclick="plaidReverse(${p.id})">Reverse</button>` : ''}
                <button class="btn-danger" style="font-size:10px;padding:2px 8px;margin-left:6px;" onclick="plaidDelete(${p.id})">Delete</button>
              </td>
            </tr>`;
          })
          .join('');
      } catch (e) {
        console.error('loadPlaidImports error:', e);
      }
    }

    async function plaidAssign(pendingId) {
      const empId = document.getElementById(`pending-assign-${pendingId}`)?.value;
      if (!empId) {
        alert('Please select an employee');
        return;
      }
      const comments = document.getElementById(`pending-comments-${pendingId}`)?.value?.trim() || null;
      try {
        const resp = await adminFetch(`/api/admin/plaid/pending/${pendingId}/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employeeId: empId, comments }),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.message);
        loadPlaidPending();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function plaidDiscard(pendingId) {
      if (!confirm('Discard this transaction? It will not be recorded as a payout.')) return;
      try {
        const resp = await adminFetch(`/api/admin/plaid/pending/${pendingId}`, { method: 'DELETE' });
        const data = await resp.json();
        if (!data.success) throw new Error(data.message);
        loadPlaidPending();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function plaidVerify(paymentId) {
      try {
        const resp = await adminFetch(`/api/admin/plaid/payments/${paymentId}/verify`, {
          method: 'POST',
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.message);
        loadPlaidImports();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function plaidReverse(paymentId) {
      if (!confirm('Reverse this auto-import? The payment will be deleted and returned to pending review.'))
        return;
      try {
        const resp = await adminFetch(`/api/admin/plaid/payments/${paymentId}/reverse`, {
          method: 'DELETE',
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.message);
        loadBankIntegration();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function plaidDelete(paymentId) {
      if (!confirm('Permanently delete this payment record?')) return;
      try {
        const resp = await adminFetch(`/api/admin/plaid/payments/${paymentId}`, { method: 'DELETE' });
        const data = await resp.json();
        if (!data.success) throw new Error(data.message);
        loadPlaidImports();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function plaidReset() {
      if (
        !confirm(
          'This will delete ALL Plaid-imported payments and pending transactions, and reset the sync cursor. This cannot be undone. Continue?',
        )
      )
        return;
      const btn = document.getElementById('plaid-reset-btn');
      btn.disabled = true;
      btn.textContent = 'Resetting...';
      try {
        const resp = await adminFetch('/api/admin/plaid/reset', { method: 'DELETE' });
        const data = await resp.json();
        if (!data.success) throw new Error(data.message);
        document.getElementById('plaid-sync-status').textContent = 'Reset complete — cursor cleared';
        document.getElementById('plaid-sync-status').style.color = '#6bff6b';
        await loadBankIntegration();
      } catch (e) {
        alert('Reset failed: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Reset All Data';
      }
    }

    // Expose modal functions globally for inline onclick attributes
    window.openPaymentModal = openPaymentModal;
    window.closePaymentModal = closePaymentModal;
    window.savePayment = savePayment;

    // Check if already logged in
    if (sessionStorage.getItem('adminAuth')) {
      showScreen('admin-screen');
      updatePeriodDisplay();
      loadEmployeesForFilter();
      loadReviewEntries();
      loadEmployees();
    }
