import './style.css';

const measureBtn = document.getElementById('measureBtn');
const statusText = document.getElementById('status');
const canvas = document.getElementById('irCanvas');
const ctx = canvas.getContext('2d');

const SAMPLE_RATE = 48000;
const SWEEP_DURATION = 2.0; 
const SWEEP_START_FREQ = 20;
const SWEEP_END_FREQ = 20000;
const N_FFT = 4096; // Размер FIR-фильтра

let audioCtx = null;

// ==========================================
// ВСТРОЕННЫЙ БЫСТРЫЙ FFT (Без библиотек)
// ==========================================
function fft(re, im) {
  let n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let temp = re[i]; re[i] = re[j]; re[j] = temp;
      temp = im[i]; im[i] = im[j]; im[j] = temp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    let ang = 2 * Math.PI / len;
    let wlen_re = Math.cos(ang);
    let wlen_im = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let w_re = 1, w_im = 0;
      for (let j = 0; j < len / 2; j++) {
        let u_re = re[i + j], u_im = im[i + j];
        let v_re = re[i + j + len / 2] * w_re - im[i + j + len / 2] * w_im;
        let v_im = re[i + j + len / 2] * w_im + im[i + j + len / 2] * w_re;
        re[i + j] = u_re + v_re;
        im[i + j] = u_im + v_im;
        re[i + j + len / 2] = u_re - v_re;
        im[i + j + len / 2] = u_im - v_im;
        let next_w_re = w_re * wlen_re - w_im * wlen_im;
        w_im = w_re * wlen_im + w_im * wlen_re;
        w_re = next_w_re;
      }
    }
  }
}

function ifft(re, im) {
  let n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

// ==========================================
// ОТРИСОВКА И СИГНАЛЫ
// ==========================================
function drawPlots(irData, invData) {
  const w = canvas.width;
  const h = canvas.height;
  
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  
  ctx.strokeStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(0, h/2);
  ctx.lineTo(w, h/2);
  ctx.stroke();

  // Оригинальный импульс (Верх)
  ctx.strokeStyle = '#00e676';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const step1 = Math.max(1, Math.floor(irData.length / w));
  for (let i = 0; i < w; i++) {
    const idx = i * step1;
    if (idx < irData.length) {
      const y = (h/4) - (irData[idx] * h/2.5);
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
  }
  ctx.stroke();

  // Инверсный FIR (Низ)
  ctx.strokeStyle = '#00b0ff';
  ctx.beginPath();
  const step2 = Math.max(1, Math.floor(invData.length / w));
  for (let i = 0; i < w; i++) {
    const idx = i * step2;
    if (idx < invData.length) {
      const y = (3*h/4) - (invData[idx] * h/2.5);
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
  }
  ctx.stroke();
}

function createSweep() {
  const length = Math.floor(SAMPLE_RATE * SWEEP_DURATION);
  const buffer = audioCtx.createBuffer(1, length, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  const w1 = SWEEP_START_FREQ * 2 * Math.PI;
  const w2 = SWEEP_END_FREQ * 2 * Math.PI;
  const T = SWEEP_DURATION;
  const K = (w2 / w1);
  
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    const phase = (w1 * T / Math.log(K)) * (Math.exp(t * Math.log(K) / T) - 1);
    data[i] = Math.sin(phase) * 0.5;
  }
  return buffer;
}

function createInverseSweep(sweepBuffer) {
  const length = sweepBuffer.length;
  const invBuffer = audioCtx.createBuffer(1, length, SAMPLE_RATE);
  const sweepData = sweepBuffer.getChannelData(0);
  const invData = invBuffer.getChannelData(0);
  
  for (let i = 0; i < length; i++) {
    const t = (length - 1 - i) / SAMPLE_RATE;
    const envelope = Math.exp(-t * Math.log(SWEEP_END_FREQ / SWEEP_START_FREQ) / SWEEP_DURATION);
    invData[i] = sweepData[length - 1 - i] * envelope;
  }
  return invBuffer;
}

// ==========================================
// МАТЕМАТИКА
// ==========================================
async function processMeasurement(recordedData, sweepBuffer) {
  statusText.textContent = 'Деконволюция (расчет IR)...';

  // 1. Деконволюция через OfflineAudioContext
  const invSweep = createInverseSweep(sweepBuffer);
  const offlineCtx = new OfflineAudioContext(1, recordedData.length + invSweep.length, SAMPLE_RATE);
  const recordNode = offlineCtx.createBufferSource();
  const recBuffer = offlineCtx.createBuffer(1, recordedData.length, SAMPLE_RATE);
  recBuffer.copyToChannel(recordedData, 0);
  recordNode.buffer = recBuffer;

  const convolver = offlineCtx.createConvolver();
  convolver.normalize = false;
  convolver.buffer = invSweep;

  recordNode.connect(convolver);
  convolver.connect(offlineCtx.destination);
  recordNode.start();

  const renderedBuffer = await offlineCtx.startRendering();
  const irData = renderedBuffer.getChannelData(0);

  // Находим пик (прямой звук)
  let maxIdx = 0;
  let maxVal = 0;
  for (let i = 0; i < irData.length; i++) {
    if (Math.abs(irData[i]) > maxVal) { maxVal = Math.abs(irData[i]); maxIdx = i; }
  }
  
  // Вырезаем кусок вокруг пика для FIR
  const startIdx = Math.max(0, maxIdx - 512);
  const irSegment = new Float32Array(N_FFT);
  for(let i=0; i<N_FFT; i++) {
      if(startIdx + i < irData.length) irSegment[i] = irData[startIdx + i];
  }
  
  // 2. Расчет инверсного FIR
  statusText.textContent = 'Расчет инверсного FIR...';
  
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  for(let i=0; i<N_FFT; i++) re[i] = irSegment[i]; // Заполняем реальную часть

  fft(re, im); // Прямое FFT

  const beta = 0.0001; // Регуляризация
  for (let i = 0; i < N_FFT; i++) {
    const magSq = re[i] * re[i] + im[i] * im[i];
    const invMagSq = 1.0 / (magSq + beta);
    
    // H_inv = conj(H) / (|H|^2 + beta)
    const temp_re = re[i] * invMagSq;
    im[i] = -im[i] * invMagSq;
    re[i] = temp_re;
  }

  ifft(re, im); // Обратное FFT

  // Сдвигаем на N_FFT/2 (modeling delay) и применяем окно
  const shiftedFir = new Float32Array(N_FFT);
  const delay = N_FFT / 2;
  
  for (let i = 0; i < N_FFT; i++) {
    // Окно Ханна
    const win = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N_FFT - 1)));
    
    // Циклический сдвиг (чтобы импульс был в центре)
    const origIdx = (i - delay + N_FFT) % N_FFT;
    shiftedFir[i] = re[origIdx] * win;
  }

  drawPlots(irSegment, shiftedFir);
  statusText.textContent = 'Готово! FIR рассчитан.';
}

// ==========================================
// ЗАПУСК ИЗМЕРЕНИЯ
// ==========================================
async function startMeasurement() {
  try {
    measureBtn.disabled = true;
    statusText.textContent = 'Инициализация...';
    
    if (!audioCtx) audioCtx = new window.AudioContext({ sampleRate: SAMPLE_RATE });
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    statusText.textContent = 'Доступ к микрофону...';
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });

    const sweepBuffer = createSweep();
    const sweepSource = audioCtx.createBufferSource();
    sweepSource.buffer = sweepBuffer;
    sweepSource.connect(audioCtx.destination);

    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1); 
    
    let recordedData = [];
    processor.onaudioprocess = (e) => {
      recordedData.push(...e.inputBuffer.getChannelData(0));
    };

    source.connect(processor);
    const muteGain = audioCtx.createGain();
    muteGain.gain.value = 0;
    processor.connect(muteGain);
    muteGain.connect(audioCtx.destination);

    statusText.textContent = 'Играем свип...';
    sweepSource.start();
    
    setTimeout(async () => {
      source.disconnect();
      processor.disconnect();
      stream.getTracks().forEach(track => track.stop());

      const dataArray = new Float32Array(recordedData);
      let startIdx = dataArray.findIndex(v => Math.abs(v) > 0.01);
      if(startIdx > 0) startIdx = Math.max(0, startIdx - 500);
      else startIdx = 0;

      await processMeasurement(dataArray.subarray(startIdx), sweepBuffer);
      
      measureBtn.disabled = false;
    }, (SWEEP_DURATION + 1.0) * 1000);

  } catch (err) {
    console.error(err);
    statusText.textContent = 'Ошибка: ' + err.message;
    measureBtn.disabled = false;
  }
}

measureBtn.addEventListener('click', startMeasurement);
