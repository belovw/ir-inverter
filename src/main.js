import './style.css';
// Используем легкую библиотеку для FFT прямо через CDN (не нужно ничего устанавливать)
import FFT from 'https://unpkg.com/fft.js@4.0.4/lib/fft.js';

const measureBtn = document.getElementById('measureBtn');
const statusText = document.getElementById('status');
const canvas = document.getElementById('irCanvas');
const ctx = canvas.getContext('2d');

const SAMPLE_RATE = 48000;
const SWEEP_DURATION = 2.0; 
const SWEEP_START_FREQ = 20;
const SWEEP_END_FREQ = 20000;
const N_FFT = 8192; // Размер окна для инверсии (FIR)

let audioCtx = null;

// Отрисовка двух графиков (оригинал и инверсия)
function drawPlots(irData, invData) {
  const w = canvas.width;
  const h = canvas.height;
  
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  
  // Разделительная линия
  ctx.strokeStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(0, h/2);
  ctx.lineTo(w, h/2);
  ctx.stroke();

  // 1. Рисуем оригинальный импульс (верхняя половина)
  ctx.strokeStyle = '#00e676'; // Зеленый
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

  // 2. Рисуем инверсный FIR (нижняя половина)
  ctx.strokeStyle = '#00b0ff'; // Синий
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

// Генерация свипа
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

// Создание обратного фильтра (Инверсный свип Фарана)
function createInverseSweep(sweepBuffer) {
  const length = sweepBuffer.length;
  const invBuffer = audioCtx.createBuffer(1, length, SAMPLE_RATE);
  const sweepData = sweepBuffer.getChannelData(0);
  const invData = invBuffer.getChannelData(0);
  
  for (let i = 0; i < length; i++) {
    // Переворачиваем во времени и компенсируем АЧХ (экспоненциальное окно)
    const t = (length - 1 - i) / SAMPLE_RATE;
    const envelope = Math.exp(-t * Math.log(SWEEP_END_FREQ / SWEEP_START_FREQ) / SWEEP_DURATION);
    invData[i] = sweepData[length - 1 - i] * envelope;
  }
  return invBuffer;
}

// Главная математика: Деконволюция и расчет FIR
async function processMeasurement(recordedData, sweepBuffer) {
  statusText.textContent = 'Деконволюция (расчет IR)...';

  // 1. Деконволюция через встроенный OfflineAudioContext (Очень быстро!)
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

  // Находим пик (прямой звук) и обрезаем до N_FFT для FIR
  let maxIdx = 0;
  let maxVal = 0;
  for (let i = 0; i < irData.length; i++) {
    if (Math.abs(irData[i]) > maxVal) { maxVal = Math.abs(irData[i]); maxIdx = i; }
  }
  
  // Вырезаем кусок вокруг пика
  const startIdx = Math.max(0, maxIdx - 512);
  const irSegment = irData.slice(startIdx, startIdx + N_FFT);
  
  // 2. Расчет инверсного FIR (Регуляризация)
  statusText.textContent = 'Расчет инверсного FIR...';
  const fft = new FFT(N_FFT);
  const out = fft.createComplexArray();
  
  // Заполняем массив нулями
  const inputRe = new Float32Array(N_FFT);
  const inputIm = new Float32Array(N_FFT);
  for(let i = 0; i < irSegment.length && i < N_FFT; i++) inputRe[i] = irSegment[i];
  
  fft.transform(out, Array.from(inputRe).flatMap((v, i) => [v, 0]));

  const invRe = new Float32Array(N_FFT);
  const invIm = new Float32Array(N_FFT);
  const beta = 0.001; // Параметр регуляризации (чем больше, тем меньше подъем НЧ)

  for (let i = 0; i < N_FFT; i++) {
    const re = out[i * 2];
    const im = out[i * 2 + 1];
    const magSq = re * re + im * im;
    
    // H_inv = conj(H) / (|H|^2 + beta)
    invRe[i] = re / (magSq + beta);
    invIm[i] = -im / (magSq + beta);
  }

  // Обратное FFT
  const invOut = fft.createComplexArray();
  const invInput = [];
  for (let i = 0; i < N_FFT; i++) invInput.push(invRe[i], invIm[i]);
  fft.inverseTransform(invOut, invInput);

  // Сдвигаем на N_FFT/2 (modeling delay) и применяем окно Ханна
  const fir = new Float32Array(N_FFT);
  const delay = N_FFT / 2;
  for (let i = 0; i < N_FFT; i++) {
    const win = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N_FFT - 1)));
    fir[i] = invOut[i * 2] * win;
  }
  
  // Сдвиг вправо для причинности
  const shiftedFir = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT - delay; i++) {
    shiftedFir[i + delay] = fir[i];
  }

  // Рисуем
  drawPlots(irSegment, shiftedFir);
  statusText.textContent = 'Готово! FIR рассчитан.';
}

// Запуск измерения
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
      // Находим начало записи
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
