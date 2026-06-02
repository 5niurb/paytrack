    // State
    let currentEmployee = null;
    let currentPin = '';
    let selectedDate = new Date();
    let periodOffset = 0;
    let currentPayPeriod = null;
    let conflictEntryId = null;
    let pendingEntry = null;
    let serviceCount = 0;
    let salesCount = 0;
    let currentTab = 'entry';

    // DOM cache for frequently-accessed elements (reduces querySelector overhead by ~90%)
    const $ = {
      pinInput: document.getElementById('pin-input'),
      loginError: document.getElementById('login-error'),
      loginScreen: document.getElementById('login-screen'),
      mainScreen: document.getElementById('main-screen'),
      employeeName: document.getElementById('employee-name'),
      tabEntryBtn: document.getElementById('tab-entry-btn'),
      tabReviewBtn: document.getElementById('tab-review-btn'),
      tabEntry: document.getElementById('tab-entry'),
      tabReview: document.getElementById('tab-review'),
      serviceSection: document.getElementById('service-section'),
      salesSection: document.getElementById('sales-section'),
      reviewEntriesBody: document.getElementById('review-entries-body'),
      reviewEntriesFooter: document.getElementById('review-entries-footer'),
      selectedDayName: document.getElementById('selected-day-name'),
      selectedFullDate: document.getElementById('selected-full-date'),
      dateWheelInner: document.getElementById('date-wheel-inner'),
      dateScrollDown: document.getElementById('date-scroll-down'),
      reviewTotalHours: document.getElementById('review-total-hours'),
      reviewTotalWages: document.getElementById('review-total-wages'),
      reviewTotalService: document.getElementById('review-total-service'),
      reviewTotalSales: document.getElementById('review-total-sales'),
      reviewTotalTips: document.getElementById('review-total-tips'),
      reviewTotalCash: document.getElementById('review-total-cash'),
      reviewTotalPayouts: document.getElementById('review-total-payouts'),
      reviewTotalPayable: document.getElementById('review-total-payable'),
      calculatedTime: document.getElementById('calculated-time'),
      calculatedHours: document.getElementById('calculated-hours'),
      entryError: document.getElementById('entry-error'),
      entrySuccess: document.getElementById('entry-success'),
      periodDates: document.getElementById('period-dates'),
      periodHours: document.getElementById('period-hours'),
      periodWages: document.getElementById('period-wages'),
      periodCommissions: document.getElementById('period-commissions'),
      periodTips: document.getElementById('period-tips'),
      periodTotal: document.getElementById('period-total'),
      startTime: document.getElementById('start-time'),
      endTime: document.getElementById('end-time'),
      breakMinutes: document.getElementById('break-minutes'),
      entryNotes: document.getElementById('entry-notes'),
      serviceEntriesContainer: document.getElementById('service-entries-container'),
      salesEntriesContainer: document.getElementById('sales-entries-container'),
      submitEntryBtn: document.getElementById('submit-entry-btn'),
      submitInvoiceBtn: document.getElementById('submit-invoice-btn'),
      invoicePreview: document.getElementById('invoice-preview'),
      invoiceModal: document.getElementById('invoice-modal'),
      conflictModal: document.getElementById('conflict-modal'),
      conflictMessage: document.getElementById('conflict-message'),
      currentPinInput: document.getElementById('current-pin'),
      newPinInput: document.getElementById('new-pin'),
      confirmPinInput: document.getElementById('confirm-pin'),
      pinError: document.getElementById('pin-error'),
      pinSuccess: document.getElementById('pin-success'),
      pinModal: document.getElementById('pin-modal'),
      invoiceStatus: document.getElementById('invoice-status'),
      nextPeriodBtn: document.getElementById('next-period-btn'),
      prevPeriodBtn: document.getElementById('prev-period-btn')
    };

    function fmtAmt(val) {
      return parseFloat(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatHoursDisplay(decimalHours) {
      const h = Math.floor(decimalHours);
      const m = Math.round((decimalHours - h) * 60);
      return `${h}:${String(m).padStart(2, '0')} / ${decimalHours.toFixed(2)}`;
    }

    // Get current date/time in Los Angeles timezone
    function getLADate() {
      const now = new Date();
      const laTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      return laTime;
    }

    // Get today's date string in LA timezone (YYYY-MM-DD)
    function getLAToday() {
      const la = getLADate();
      return `${la.getFullYear()}-${String(la.getMonth() + 1).padStart(2, '0')}-${String(la.getDate()).padStart(2, '0')}`;
    }

    // Initialize
    $.pinInput.addEventListener('keypress', e => {
      if (e.key === 'Enter') login();
    });

    // Tab Switching
    function switchTab(tab) {
      currentTab = tab;

      // Update tab buttons
      $.tabEntryBtn.classList.toggle('active', tab === 'entry');
      $.tabReviewBtn.classList.toggle('active', tab === 'review');

      // Update tab content
      $.tabEntry.classList.toggle('active', tab === 'entry');
      $.tabReview.classList.toggle('active', tab === 'review');

      // Load review data when switching to review tab
      if (tab === 'review') {
        loadPayPeriod();
        loadReviewEntries();
      }
    }

    // Check for saved session
    const savedEmployee = sessionStorage.getItem('employee');
    const savedPin = sessionStorage.getItem('pin');
    if (savedEmployee) {
      currentEmployee = JSON.parse(savedEmployee);
      currentPin = savedPin;
      showMainScreen();
    }

    // Login
    async function login() {
      const pin = $.pinInput.value;
      $.loginError.classList.remove('show');

      try {
        const response = await fetch('/api/verify-pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin })
        });

        const data = await response.json();

        if (data.success) {
          currentEmployee = data.employee;
          currentPin = pin;
          sessionStorage.setItem('employee', JSON.stringify(currentEmployee));
          sessionStorage.setItem('pin', pin);
          showMainScreen();
        } else {
          $.loginError.classList.add('show');
          $.pinInput.value = '';
        }
      } catch (error) {
        $.loginError.textContent = 'Connection error';
        $.loginError.classList.add('show');
      }
    }

    function logout() {
      currentEmployee = null;
      currentPin = '';
      sessionStorage.removeItem('employee');
      sessionStorage.removeItem('pin');
      $.pinInput.value = '';
      $.loginScreen.classList.add('active');
      $.mainScreen.classList.remove('active');
    }

    function showMainScreen() {
      $.loginScreen.classList.remove('active');
      $.mainScreen.classList.add('active');
      $.employeeName.textContent = currentEmployee.name;

      // Show/hide sections based on pay type
      const payType = currentEmployee.pay_type;

      // Determine what to show
      const showServices = ['commission_services', 'hourly_services', 'hourly_all'].includes(payType);
      const showSales = ['commission_sales', 'hourly_sales', 'hourly_all'].includes(payType);

      $.serviceSection.style.display = showServices ? 'block' : 'none';
      $.salesSection.style.display = showSales ? 'block' : 'none';

      // Reset to entry tab
      switchTab('entry');

      initializeDatePicker();
      loadPayPeriod();
    }

    // Load Review Entries for Pay Review Tab
    async function loadReviewEntries() {
      if (!currentPayPeriod) return;

      $.reviewEntriesBody.innerHTML = '<tr><td colspan="9" class="no-entries">Loading...</td></tr>';
      $.reviewEntriesFooter.style.display = 'none';

      try {
        const response = await fetch(`/api/invoice-preview/${currentEmployee.id}?periodStart=${currentPayPeriod.periodStart}&periodEnd=${currentPayPeriod.periodEnd}`);
        const data = await response.json();

        if (!data.entries || data.entries.length === 0) {
          tbody.innerHTML = '<tr><td colspan="9" class="no-entries">No entries for this pay period</td></tr>';
          return;
        }

        // Format date for display
        const formatDateShort = (dateStr) => {
          const d = new Date(dateStr + 'T00:00:00');
          const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          return `${days[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
        };

        // Sort entries by date descending (most recent first)
        const sortedEntries = [...data.entries].sort((a, b) => {
          return new Date(b.date) - new Date(a.date);
        });

        // Fetch payouts for this employee/period
        let payoutsByDate = {};
        let totalPayouts = 0;
        try {
          const payoutsUrl = `/api/employee/payouts/${currentEmployee.id}?periodStart=${currentPayPeriod.periodStart}&periodEnd=${currentPayPeriod.periodEnd}`;
          const payoutsResp = await fetch(payoutsUrl);
          if (payoutsResp.ok) {
            const payoutsData = await payoutsResp.json();
            if (Array.isArray(payoutsData)) {
              payoutsData.forEach(p => {
                payoutsByDate[p.payment_date] = (payoutsByDate[p.payment_date] || 0) + parseFloat(p.amount || 0);
                totalPayouts += parseFloat(p.amount || 0);
              });
            }
          }
        } catch (e) {
          // Non-fatal — payouts column will show $0.00
        }

        // Build rows
        let rows = '';
        sortedEntries.forEach(entry => {
          const dayPayouts = payoutsByDate[entry.date] || 0;
          const dayTotal = entry.wages + entry.commissions + entry.productCommissions + entry.tips - entry.cashTips - dayPayouts;
          rows += `
            <tr>
              <td>${formatDateShort(entry.date)}</td>
              <td class="right">${formatHoursDisplay(entry.hours)}</td>
              <td class="right">$${fmtAmt(entry.wages)}</td>
              <td class="right">$${fmtAmt(entry.commissions)}</td>
              <td class="right">$${fmtAmt(entry.productCommissions)}</td>
              <td class="right">$${fmtAmt(entry.tips)}</td>
              <td class="right cash-tips">${entry.cashTips > 0 ? '-$' + fmtAmt(entry.cashTips) : '-'}</td>
              <td class="right cash-tips">${dayPayouts > 0 ? '-$' + fmtAmt(dayPayouts) : '-'}</td>
              <td class="right" style="font-weight: 600;">$${fmtAmt(dayTotal)}</td>
              <td class="right"><button class="btn-delete-small" onclick="deleteReviewEntry(${entry.id}, '${entry.date}')">Delete</button></td>
            </tr>
          `;
        });
        $.reviewEntriesBody.innerHTML = rows;

        // Update footer totals
        const s = data.summary;
        const totalPayable = s.totalPayable - totalPayouts;
        $.reviewTotalHours.textContent = formatHoursDisplay(s.totalHours);
        $.reviewTotalWages.textContent = '$' + fmtAmt(s.totalWages);
        $.reviewTotalService.textContent = '$' + fmtAmt(s.totalCommissions);
        $.reviewTotalSales.textContent = '$' + fmtAmt(s.totalProductCommissions);
        $.reviewTotalTips.textContent = '$' + fmtAmt(s.totalTips);
        $.reviewTotalCash.textContent = '-$' + fmtAmt(s.totalCashTips);
        $.reviewTotalPayouts.textContent = '-$' + fmtAmt(totalPayouts);
        $.reviewTotalPayable.textContent = '$' + fmtAmt(totalPayable);
        $.reviewEntriesFooter.style.display = 'table-footer-group';

      } catch (error) {
        console.error('Error loading review entries:', error);
        $.reviewEntriesBody.innerHTML = '<tr><td colspan="8" class="no-entries" style="color: #ff6b6b;">Error loading entries</td></tr>';
      }
    }

    // Date Picker
    function initializeDatePicker() {
      selectedDate = getLADate();
      selectedDate.setHours(0, 0, 0, 0);
      updateDateDisplay();
      buildDateWheel();
      enableDateWheelDrag();
    }

    // Touch/finger (and mouse) drag to scrub the date wheel. Dragging DOWN reveals
    // earlier dates, UP reveals later dates — one wheel item is 40px tall, so every
    // 40px of drag = one day. Snaps to the nearest valid (non-future) date on release.
    function enableDateWheelDrag() {
      const wheel = document.getElementById('date-wheel');
      if (!wheel || wheel.dataset.dragBound === '1') return;
      wheel.dataset.dragBound = '1';
      wheel.style.touchAction = 'none';      // let us own vertical drags (no page scroll hijack)
      wheel.style.cursor = 'grab';

      const ITEM_H = 40;
      const CENTER_OFFSET = 80;   // center band top = (wheel 200 - item 40) / 2
      let dragging = false, startY = 0, lastApplied = 0, baseTransform = -30 * ITEM_H + CENTER_OFFSET;

      const onDown = (e) => {
        dragging = true;
        lastApplied = 0;
        startY = (e.touches ? e.touches[0].clientY : e.clientY);
        wheel.style.cursor = 'grabbing';
        // disable the CSS transition during the drag for 1:1 finger tracking
        $.dateWheelInner.style.transition = 'none';
        if (e.cancelable) e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        const y = (e.touches ? e.touches[0].clientY : e.clientY);
        const dy = y - startY;
        // live visual follow
        $.dateWheelInner.style.transform = `translateY(${baseTransform + dy}px)`;
        // apply day shifts as the finger crosses each item boundary
        const steps = Math.round(dy / ITEM_H);     // down (+dy) => earlier dates
        if (steps !== lastApplied) {
          const delta = steps - lastApplied;
          lastApplied = steps;
          // dragging down (positive dy) should go to earlier dates => offset -delta
          shiftDate(-delta);
        }
        if (e.cancelable) e.preventDefault();
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        wheel.style.cursor = 'grab';
        $.dateWheelInner.style.transition = '';     // restore transition
        buildDateWheel();                           // re-center / snap
      };

      wheel.addEventListener('touchstart', onDown, { passive: false });
      wheel.addEventListener('touchmove', onMove, { passive: false });
      wheel.addEventListener('touchend', onUp);
      wheel.addEventListener('touchcancel', onUp);
      wheel.addEventListener('mousedown', onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    // Shift the selected date by N days, clamped to not go past today (future-blocked),
    // without rebuilding the wheel mid-drag (buildDateWheel snaps on release).
    function shiftDate(days) {
      const today = getLADate();
      today.setHours(0, 0, 0, 0);
      const candidate = new Date(selectedDate);
      candidate.setDate(candidate.getDate() + days);
      if (candidate <= today) {
        selectedDate = candidate;
        updateDateDisplay();
      }
    }

    function updateDateDisplay() {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

      const dayName = days[selectedDate.getDay()];
      const month = months[selectedDate.getMonth()];
      const date = selectedDate.getDate();
      const year = selectedDate.getFullYear();

      const suffix = getOrdinalSuffix(date);

      $.selectedDayName.textContent = dayName;
      $.selectedFullDate.textContent = `${month} ${date}${suffix}, ${year}`;
    }

    function getOrdinalSuffix(n) {
      const s = ['th', 'st', 'nd', 'rd'];
      const v = n % 100;
      return s[(v - 20) % 10] || s[v] || s[0];
    }

    function buildDateWheel() {
      $.dateWheelInner.innerHTML = '';

      // Use LA timezone for "today"
      const today = getLADate();
      today.setHours(0, 0, 0, 0);

      // Show 30 days back and forward
      for (let i = -30; i <= 30; i++) {
        const date = new Date(selectedDate);
        date.setDate(selectedDate.getDate() + i);

        const item = document.createElement('div');
        item.className = 'date-wheel-item';

        if (date > today) {
          item.classList.add('future');
        }

        if (i === 0) {
          item.classList.add('selected');
        }

        const dayAbbr = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
        item.textContent = `${dayAbbr} ${date.getMonth() + 1}/${date.getDate()}`;
        item.dataset.offset = i;

        item.onclick = () => {
          if (date <= today) {
            selectDateByOffset(i);
          }
        };

        $.dateWheelInner.appendChild(item);
      }

      // Position to show selected in the center band (row 3 of 5 visible rows).
      // Selected item is index 30; center row top is at 80px (= (200-40)/2).
      $.dateWheelInner.style.transform = `translateY(${-30 * 40 + 80}px)`;

      updateScrollButtons();
    }

    function scrollDate(direction) {
      // Use LA timezone for "today"
      const today = getLADate();
      today.setHours(0, 0, 0, 0);

      const newDate = new Date(selectedDate);
      newDate.setDate(newDate.getDate() + direction);

      if (newDate <= today) {
        selectedDate = newDate;
        updateDateDisplay();
        buildDateWheel();
      }
    }

    function selectDateByOffset(offset) {
      // Use LA timezone for "today"
      const today = getLADate();
      today.setHours(0, 0, 0, 0);

      const newDate = new Date(selectedDate);
      newDate.setDate(newDate.getDate() + offset);

      if (newDate <= today) {
        selectedDate = newDate;
        updateDateDisplay();
        buildDateWheel();
      }
    }

    function updateScrollButtons() {
      // Use LA timezone for "today"
      const today = getLADate();
      today.setHours(0, 0, 0, 0);

      const downBtn = $.dateScrollDown;
      const nextDay = new Date(selectedDate);
      nextDay.setDate(nextDay.getDate() + 1);

      downBtn.disabled = nextDay > today;
    }

    // Time Calculation
    // Snap a "HH:MM" time string to the nearest 5-minute increment. The native
    // <input type="time"> picker ignores the `step` attribute in its wheel UI
    // (step only gates form validation), so users can scroll to any minute.
    // We enforce 5-min granularity here, where every change runs through.
    function snapTimeToFive(value) {
      if (!value) return value;
      const [h, m] = value.split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return value;
      let total = h * 60 + Math.round(m / 5) * 5;
      total = ((total % 1440) + 1440) % 1440; // wrap within a day
      const hh = String(Math.floor(total / 60)).padStart(2, '0');
      const mm = String(total % 60).padStart(2, '0');
      return `${hh}:${mm}`;
    }

    function calculateHours() {
      // Enforce 5-minute increments on the time inputs (native picker allows any minute).
      const snappedStart = snapTimeToFive($.startTime.value);
      if (snappedStart !== $.startTime.value) $.startTime.value = snappedStart;
      const snappedEnd = snapTimeToFive($.endTime.value);
      if (snappedEnd !== $.endTime.value) $.endTime.value = snappedEnd;

      const startTime = $.startTime.value;
      const endTime = $.endTime.value;
      const breakMinutes = parseInt($.breakMinutes.value) || 0;

      if (startTime && endTime) {
        const start = new Date(`2000-01-01T${startTime}`);
        let end = new Date(`2000-01-01T${endTime}`);

        if (end < start) {
          end.setDate(end.getDate() + 1);
        }

        const diffMs = end - start;
        const diffHours = (diffMs / (1000 * 60 * 60)) - (breakMinutes / 60);
        const hours = Math.max(0, diffHours);

        const totalMinutes = Math.round(hours * 60);
        const hh = Math.floor(totalMinutes / 60);
        const mm = String(totalMinutes % 60).padStart(2, '0');
        $.calculatedTime.textContent = `${hh}:${mm}`;
        $.calculatedHours.textContent = hours.toFixed(2);
        return hours;
      }

      $.calculatedTime.textContent = '0:00';
      $.calculatedHours.textContent = '0.00';
      return 0;
    }

    // Service Entries (renamed from Patient)
    function addServiceEntry() {
      serviceCount++;
      const container = $.serviceEntriesContainer;

      const entry = document.createElement('div');
      entry.className = 'service-entry';
      entry.id = `service-${serviceCount}`;
      entry.innerHTML = `
        <div class="service-entry-header">
          <span class="service-entry-title">Service #${serviceCount}</span>
          <button class="remove-entry" onclick="removeServiceEntry(${serviceCount})">&times;</button>
        </div>
        <div class="form-group">
          <label>Service Description</label>
          <input type="text" class="service-client" placeholder="Service / client details">
        </div>
        <div class="form-group">
          <label>Procedure</label>
          <input type="text" class="service-name" placeholder="Procedure performed">
        </div>
        <div class="time-row">
          <div class="form-group">
            <label>Earnings ($)</label>
            <input type="number" class="service-earnings" step="0.01" min="0" placeholder="0.00">
          </div>
          <div class="form-group">
            <label>Tip ($)</label>
            <input type="number" class="service-tip" step="0.01" min="0" placeholder="0.00">
          </div>
        </div>
        <div class="form-group">
          <label>Notes</label>
          <input type="text" class="service-notes" placeholder="Optional notes">
        </div>
        <label class="checkbox-group">
          <input type="checkbox" class="tip-cash">
          <span>Tip received in cash (already paid out)</span>
        </label>
      `;

      container.appendChild(entry);
    }

    function removeServiceEntry(id) {
      const entry = document.getElementById(`service-${id}`);
      if (entry) entry.remove();
    }

    // Sales Entries with commission type toggle
    function addSalesEntry() {
      salesCount++;
      const container = $.salesEntriesContainer;

      const entry = document.createElement('div');
      entry.className = 'sales-entry';
      entry.id = `sales-${salesCount}`;
      entry.innerHTML = `
        <div class="service-entry-header">
          <span class="service-entry-title">Sale #${salesCount}</span>
          <button class="remove-entry" onclick="removeSalesEntry(${salesCount})">&times;</button>
        </div>
        <div class="form-group">
          <label>Product Name</label>
          <input type="text" class="product-name" placeholder="Product sold">
        </div>
        <div class="form-group">
          <label>Sale Amount ($)</label>
          <input type="number" class="product-amount" step="0.01" min="0" placeholder="0.00" oninput="calculateSalesCommission(${salesCount})">
        </div>
        <div class="form-group">
          <label>Commission Type</label>
          <div class="commission-type-toggle">
            <button type="button" class="commission-type-btn active" data-type="percent" onclick="setCommissionType(${salesCount}, 'percent')">% Percentage</button>
            <button type="button" class="commission-type-btn" data-type="flat" onclick="setCommissionType(${salesCount}, 'flat')">$ Flat Amount</button>
          </div>
        </div>
        <div class="commission-calc-row">
          <div class="form-group" id="commission-input-${salesCount}">
            <label>Commission Rate (%)</label>
            <input type="number" class="commission-rate" step="0.1" min="0" placeholder="10" oninput="calculateSalesCommission(${salesCount})">
          </div>
        </div>
        <div class="calculated-commission" id="calc-commission-${salesCount}">
          <div class="label">Commission Earned</div>
          <div class="value">$0.00</div>
        </div>
        <input type="hidden" class="commission-type" value="percent">
        <input type="hidden" class="product-commission" value="0">
        <div class="form-group" style="margin-top: 12px;">
          <label>Notes</label>
          <input type="text" class="product-notes" placeholder="Optional notes">
        </div>
      `;

      container.appendChild(entry);
    }

    function removeSalesEntry(id) {
      const entry = document.getElementById(`sales-${id}`);
      if (entry) entry.remove();
    }

    // Delete entry from Pay Review
    async function deleteReviewEntry(entryId, dateStr) {
      if (!confirm(`Are you sure you want to delete the entry for ${dateStr}?`)) {
        return;
      }

      try {
        const response = await fetch(`/api/time-entry/${entryId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'x-employee-pin': currentPin },
          body: JSON.stringify({ employeeId: currentEmployee.id })
        });

        const data = await response.json();

        if (data.success) {
          // Reload the review data
          loadPayPeriod();
          loadReviewEntries();
        } else {
          alert('Failed to delete entry: ' + (data.message || 'Unknown error'));
        }
      } catch (error) {
        console.error('Error deleting entry:', error);
        alert('Connection error while deleting entry');
      }
    }

    function setCommissionType(id, type) {
      const entry = document.getElementById(`sales-${id}`);
      if (!entry) return;

      // Update buttons
      entry.querySelectorAll('.commission-type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === type);
      });

      // Update hidden input
      entry.querySelector('.commission-type').value = type;

      // Update label
      const inputGroup = document.getElementById(`commission-input-${id}`);
      const label = inputGroup.querySelector('label');
      const input = inputGroup.querySelector('input');

      if (type === 'percent') {
        label.textContent = 'Commission Rate (%)';
        input.placeholder = '10';
      } else {
        label.textContent = 'Flat Commission ($)';
        input.placeholder = '0.00';
      }

      calculateSalesCommission(id);
    }

    function calculateSalesCommission(id) {
      const entry = document.getElementById(`sales-${id}`);
      if (!entry) return;

      const saleAmount = parseFloat(entry.querySelector('.product-amount').value) || 0;
      const commissionType = entry.querySelector('.commission-type').value;
      const rateInput = entry.querySelector('.commission-rate').value;
      const rate = parseFloat(rateInput) || 0;

      let commission = 0;
      if (commissionType === 'percent') {
        commission = saleAmount * (rate / 100);
      } else {
        commission = rate;
      }

      // Update display
      const calcDisplay = document.getElementById(`calc-commission-${id}`);
      calcDisplay.querySelector('.value').textContent = `$${fmtAmt(commission)}`;

      // Store value
      entry.querySelector('.product-commission').value = commission.toFixed(2);
    }

    // Check for conflicts
    async function checkConflict() {
      const dateStr = formatDate(selectedDate);

      try {
        const response = await fetch('/api/check-conflict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-employee-pin': currentPin },
          body: JSON.stringify({
            employeeId: currentEmployee.id,
            date: dateStr
          })
        });

        return await response.json();
      } catch (error) {
        console.error('Error checking conflict:', error);
        return { hasConflict: false };
      }
    }

    // Submit Entry
    async function submitEntry() {
      const hours = calculateHours();

      if (hours <= 0) {
        showError('entry-error', 'Please enter valid start and end times');
        return;
      }

      // Check for conflict
      const conflict = await checkConflict();

      if (conflict.hasConflict) {
        conflictEntryId = conflict.existingEntry.id;
        pendingEntry = gatherEntryData(hours);

        const existingHours = conflict.existingEntry.hours;
        const existingTime = conflict.existingEntry.start_time && conflict.existingEntry.end_time
          ? `${formatTime12(conflict.existingEntry.start_time)} - ${formatTime12(conflict.existingEntry.end_time)}`
          : `${existingHours} hours`;

        $.conflictMessage.innerHTML = `
          <strong>An entry already exists for ${formatDateDisplay(selectedDate)}:</strong><br><br>
          Existing entry: ${existingTime} (${existingHours.toFixed(2)} hours)<br><br>
          Do you want to <strong>delete the existing entry</strong> and replace it with your new entry?
        `;

        $.conflictModal.classList.add('show');
        return;
      }

      // No conflict, submit directly
      await saveEntry(gatherEntryData(hours));
    }

    function gatherEntryData(hours) {
      const clients = [];
      document.querySelectorAll('.service-entry').forEach(entry => {
        const name = entry.querySelector('.service-client').value.trim();
        const earnings = parseFloat(entry.querySelector('.service-earnings').value) || 0;
        const tip = parseFloat(entry.querySelector('.service-tip').value) || 0;
        // Include if there's a name OR any earnings/tips
        if (name || earnings > 0 || tip > 0) {
          clients.push({
            clientName: name || 'Service',
            procedure: entry.querySelector('.service-name').value.trim(),
            notes: entry.querySelector('.service-notes').value.trim(),
            amountEarned: earnings,
            tipAmount: tip,
            tipReceivedCash: entry.querySelector('.tip-cash').checked
          });
        }
      });

      const productSales = [];
      document.querySelectorAll('.sales-entry').forEach(entry => {
        const name = entry.querySelector('.product-name').value.trim();
        const amount = parseFloat(entry.querySelector('.product-amount').value) || 0;
        const commission = parseFloat(entry.querySelector('.product-commission').value) || 0;
        // Include if there's a name OR any sale amount/commission
        if (name || amount > 0 || commission > 0) {
          productSales.push({
            productName: name || 'Sale',
            saleAmount: amount,
            commissionAmount: commission,
            notes: entry.querySelector('.product-notes').value.trim()
          });
        }
      });

      return {
        employeeId: currentEmployee.id,
        date: formatDate(selectedDate),
        startTime: $.startTime.value,
        endTime: $.endTime.value,
        breakMinutes: parseInt($.breakMinutes.value) || 0,
        hours,
        description: $.entryNotes.value.trim(),
        clients,
        productSales
      };
    }

    async function overrideEntry() {
      closeConflictModal();

      // Delete existing entry
      try {
        await fetch(`/api/time-entry/${conflictEntryId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'x-employee-pin': currentPin },
          body: JSON.stringify({ employeeId: currentEmployee.id })
        });
      } catch (error) {
        console.error('Error deleting entry:', error);
      }

      // Save new entry
      await saveEntry(pendingEntry);

      conflictEntryId = null;
      pendingEntry = null;
    }

    async function saveEntry(entryData) {
      try {
        const response = await fetch('/api/time-entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-employee-pin': currentPin },
          body: JSON.stringify(entryData)
        });

        const data = await response.json();

        if (data.success) {
          showSuccess('entry-success', 'Entry saved successfully!');
          clearForm();
          loadPayPeriod();
          // Also update review tab data if it's been loaded
          if (currentTab === 'review') {
            loadReviewEntries();
          }
        } else {
          showError('entry-error', data.message || 'Failed to save entry');
        }
      } catch (error) {
        showError('entry-error', 'Connection error');
      }
    }

    function closeConflictModal() {
      $.conflictModal.classList.remove('show');
    }

    function clearForm() {
      $.startTime.value = '';
      $.endTime.value = '';
      $.breakMinutes.value = '0';
      $.entryNotes.value = '';
      $.calculatedTime.textContent = '0:00';
      $.calculatedHours.textContent = '0.00';
      $.serviceEntriesContainer.innerHTML = '';
      $.salesEntriesContainer.innerHTML = '';
      serviceCount = 0;
      salesCount = 0;
    }

    // Pay Period
    async function loadPayPeriod() {
      try {
        const response = await fetch(`/api/pay-period/${currentEmployee.id}?offset=${periodOffset}`, {
          headers: { 'x-employee-pin': currentPin }
        });
        currentPayPeriod = await response.json();

        updatePayPeriodDisplay();

        // If on review tab, also load review entries
        if (currentTab === 'review') {
          loadReviewEntries();
        }
      } catch (error) {
        console.error('Error loading pay period:', error);
      }
    }

    function updatePayPeriodDisplay() {
      if (!currentPayPeriod) return;

      const startDate = new Date(currentPayPeriod.periodStart + 'T00:00:00');
      const endDate = new Date(currentPayPeriod.periodEnd + 'T00:00:00');

      const formatPeriodDate = (d) => {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${months[d.getMonth()]} ${d.getDate()}`;
      };

      $.periodDates.textContent =
        `${formatPeriodDate(startDate)} - ${formatPeriodDate(endDate)}, ${endDate.getFullYear()}`;

      $.periodHours.textContent = currentPayPeriod.totalHours.toFixed(1);
      $.periodWages.textContent =
        `$${parseFloat(currentPayPeriod.totalWages).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      $.periodCommissions.textContent =
        `$${parseFloat(currentPayPeriod.totalCommissions + currentPayPeriod.totalProductCommissions).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      $.periodTips.textContent =
        `$${parseFloat(currentPayPeriod.totalTips).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
      $.periodTotal.textContent = `$${fmtAmt(currentPayPeriod.totalPayable)}`;

      // Invoice status
      const statusEl = $.invoiceStatus;
      const submitBtn = $.submitInvoiceBtn;

      if (currentPayPeriod.invoiceSubmitted) {
        statusEl.className = 'invoice-status submitted';
        statusEl.textContent = `Invoice submitted on ${new Date(currentPayPeriod.invoiceDate).toLocaleDateString()}`;
        submitBtn.style.display = 'none';
      } else if (periodOffset > 0) {
        statusEl.className = 'invoice-status';
        statusEl.textContent = '';
        submitBtn.style.display = 'none';
      } else {
        statusEl.className = 'invoice-status pending';
        statusEl.textContent = 'Invoice not yet submitted';
        submitBtn.style.display = 'block';
      }

      // Disable forward button if at current period
      $.nextPeriodBtn.disabled = periodOffset >= 0;
    }

    function changePeriod(direction) {
      // Don't allow going to future periods
      if (direction > 0 && periodOffset >= 0) return;

      periodOffset += direction;
      loadPayPeriod();
    }

    // Invoice
    async function showInvoicePreview() {
      if (!currentPayPeriod || currentPayPeriod.invoiceSubmitted) return;

      const preview = $.invoicePreview;
      preview.innerHTML = '<p style="text-align: center; padding: 20px;">Loading...</p>';
      $.invoiceModal.classList.add('show');

      try {
        // Fetch detailed invoice data
        const previewUrl = `/api/invoice-preview/${currentEmployee.id}?periodStart=${currentPayPeriod.periodStart}&periodEnd=${currentPayPeriod.periodEnd}`;
        const response = await fetch(previewUrl);
        const data = await response.json();

        if (!data.entries || data.entries.length === 0) {
          preview.innerHTML = '<p style="text-align: center; padding: 20px; color: #888;">No entries for this pay period</p>';
          return;
        }

        // Format date for display
        const formatDateShort = (dateStr) => {
          const d = new Date(dateStr + 'T00:00:00');
          const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          return `${days[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
        };

        // Build daily rows
        let dailyRows = '';
        data.entries.forEach(entry => {
          const dayTotal = entry.wages + entry.commissions + entry.productCommissions + entry.tips - entry.cashTips;
          dailyRows += `
            <tr>
              <td>${formatDateShort(entry.date)}</td>
              <td style="text-align: right;">${entry.hours.toFixed(2)}</td>
              <td style="text-align: right;">$${fmtAmt(entry.wages)}</td>
              <td style="text-align: right;">$${fmtAmt(entry.commissions)}</td>
              <td style="text-align: right;">$${fmtAmt(entry.productCommissions)}</td>
              <td style="text-align: right;">$${fmtAmt(entry.tips)}</td>
              <td style="text-align: right; color: #ff6b6b;">${entry.cashTips > 0 ? '-$' + fmtAmt(entry.cashTips) : '-'}</td>
              <td style="text-align: right; font-weight: 600;">$${fmtAmt(dayTotal)}</td>
            </tr>
          `;
        });

        const summary = data.summary;

        preview.innerHTML = `
          <p style="font-size: 11px; color: #888; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.1em;">
            Pay Period: ${currentPayPeriod.periodStart} to ${currentPayPeriod.periodEnd}
          </p>
          <p style="font-size: 12px; color: #aaa; margin-bottom: 16px;">
            Hourly Rate: $${data.employee.hourlyWage}/hr
          </p>
          <div style="overflow-x: auto;">
            <table class="invoice-table" style="min-width: 600px;">
              <thead>
                <tr>
                  <th>Date</th>
                  <th style="text-align: right;">Hours</th>
                  <th style="text-align: right;">Wages</th>
                  <th style="text-align: right;">Service Comm</th>
                  <th style="text-align: right;">Sales Comm</th>
                  <th style="text-align: right;">Tips</th>
                  <th style="text-align: right;">Cash Tips</th>
                  <th style="text-align: right;">Day Total</th>
                </tr>
              </thead>
              <tbody>
                ${dailyRows}
              </tbody>
              <tfoot>
                <tr style="background: #1a1a1a;">
                  <td><strong>TOTALS</strong></td>
                  <td style="text-align: right;"><strong>${summary.totalHours.toFixed(2)}</strong></td>
                  <td style="text-align: right;"><strong>$${fmtAmt(summary.totalWages)}</strong></td>
                  <td style="text-align: right;"><strong>$${fmtAmt(summary.totalCommissions)}</strong></td>
                  <td style="text-align: right;"><strong>$${fmtAmt(summary.totalProductCommissions)}</strong></td>
                  <td style="text-align: right;"><strong>$${fmtAmt(summary.totalTips)}</strong></td>
                  <td style="text-align: right; color: #ff6b6b;"><strong>-$${fmtAmt(summary.totalCashTips)}</strong></td>
                  <td style="text-align: right; color: #6bff6b; font-size: 14px;"><strong>$${fmtAmt(summary.totalPayable)}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        `;
      } catch (error) {
        console.error('Error loading invoice preview:', error);
        preview.innerHTML = '<p style="text-align: center; padding: 20px; color: #ff6b6b;">Error loading invoice details</p>';
      }
    }

    function closeInvoiceModal() {
      $.invoiceModal.classList.remove('show');
    }

    async function submitInvoice() {
      if (!currentPayPeriod) return;

      try {
        const response = await fetch('/api/submit-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            employeeId: currentEmployee.id,
            periodStart: currentPayPeriod.periodStart,
            periodEnd: currentPayPeriod.periodEnd,
            totalHours: currentPayPeriod.totalHours,
            totalWages: currentPayPeriod.totalWages,
            totalCommissions: currentPayPeriod.totalCommissions,
            totalTips: currentPayPeriod.totalTips,
            totalCashTips: currentPayPeriod.totalCashTips,
            totalProductCommissions: currentPayPeriod.totalProductCommissions,
            totalPayable: currentPayPeriod.totalPayable
          })
        });

        const data = await response.json();

        if (data.success) {
          closeInvoiceModal();
          loadPayPeriod();
          alert('Invoice submitted successfully! An email has been sent.');
        } else {
          alert(data.message || 'Failed to submit invoice');
        }
      } catch (error) {
        alert('Connection error');
      }
    }

    // PIN Change
    function showPinChangeModal() {
      $.currentPinInput.value = '';
      $.newPinInput.value = '';
      $.confirmPinInput.value = '';
      $.pinError.classList.remove('show');
      $.pinSuccess.classList.remove('show');
      $.pinModal.classList.add('show');
    }

    function closePinModal() {
      $.pinModal.classList.remove('show');
    }

    async function changePin() {
      const currentPinVal = $.currentPinInput.value;
      const newPinVal = $.newPinInput.value;
      const confirmPinVal = $.confirmPinInput.value;

      if (!/^\d{4}$/.test(newPinVal)) {
        showError('pin-error', 'New PIN must be exactly 4 digits');
        return;
      }

      if (newPinVal !== confirmPinVal) {
        showError('pin-error', 'New PINs do not match');
        return;
      }

      try {
        const response = await fetch('/api/change-pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            employeeId: currentEmployee.id,
            currentPin: currentPinVal,
            newPin: newPinVal
          })
        });

        const data = await response.json();

        if (data.success) {
          currentPin = newPinVal;
          sessionStorage.setItem('pin', newPinVal);
          showSuccess('pin-success', 'PIN changed successfully!');
          setTimeout(closePinModal, 1500);
        } else {
          showError('pin-error', data.message || 'Failed to change PIN');
        }
      } catch (error) {
        showError('pin-error', 'Connection error');
      }
    }

    // Load Entries
    async function loadEntries() {
      try {
        const response = await fetch(`/api/time-entries/${currentEmployee.id}`, {
          headers: { 'x-employee-pin': currentPin }
        });
        const entries = await response.json();

        const container = document.getElementById('entries-list');

        if (entries.length === 0) {
          container.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">No entries yet</p>';
          return;
        }

        container.innerHTML = entries.slice(0, 10).map(entry => {
          const date = new Date(entry.date + 'T00:00:00');
          const dateStr = formatDateDisplay(date);

          const timeStr = entry.start_time && entry.end_time
            ? `${formatTime12(entry.start_time)} - ${formatTime12(entry.end_time)}`
            : `${entry.hours.toFixed(1)} hours`;

          let totalEarnings = entry.hours * (currentEmployee.hourly_wage || 0);

          if (entry.clients) {
            entry.clients.forEach(c => {
              totalEarnings += (c.amount_earned || 0) + (c.tip_amount || 0);
            });
          }

          if (entry.productSales) {
            entry.productSales.forEach(p => {
              totalEarnings += p.commission_amount || 0;
            });
          }

          return `
            <div class="entry-item">
              <div class="entry-date">${dateStr}</div>
              <div class="entry-details">${timeStr} (${entry.hours.toFixed(2)} hours)</div>
              ${totalEarnings > 0 ? `<div class="entry-earnings">$${fmtAmt(totalEarnings)}</div>` : ''}
            </div>
          `;
        }).join('');
      } catch (error) {
        console.error('Error loading entries:', error);
      }
    }

    // Utility Functions
    function formatDate(date) {
      return date.toISOString().split('T')[0];
    }

    function formatDateDisplay(date) {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

      const dayName = days[date.getDay()];
      const month = months[date.getMonth()];
      const day = date.getDate();
      const suffix = getOrdinalSuffix(day);

      return `${dayName}, ${month} ${day}${suffix}`;
    }

    function formatTime12(timeStr) {
      if (!timeStr) return '';
      const [hours, minutes] = timeStr.split(':');
      const h = parseInt(hours);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 || 12;
      return `${h12}:${minutes} ${ampm}`;
    }

    function showError(id, message) {
      const el = document.getElementById(id);
      el.textContent = message;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 5000);
    }

    function showSuccess(id, message) {
      const el = document.getElementById(id);
      el.textContent = message;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 3000);
    }

    // Service Worker Registration
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        // Service worker registration failed - non-critical for PWA fallback
      });
    }
