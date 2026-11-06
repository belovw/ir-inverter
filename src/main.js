import './style.css';

const measureBtn = document.getElementById('measureBtn');
const statusText = document.getElementById('status');
const canvas = document.getElementById('irCanvas');
const ctx = canvas.getContext('2d');

const SAMPLE_RATE = 48000;
const SWEEP_DURATION = 2.0; // 2 секунды
const SWEEP_START_FREQ = 20;
const SWEEP_END_FREQ = 20000;

let audioCtx = null;

// Функция отрисовки波形 (сигнала) на канвасе
function drawWaveform(data) {
  const w = canvas.width;
  const h = canvas.height;
  
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  
  ctx.strokeStyle = '#00e676';
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  const step = Math.ceil(data.length / w);
  const amp = h / 2;

  for (let i = 0; i < w; i++) {
    let min = 1.0;
    let max = -1.0;
    for (let j = 0; j < step; j++) {
      const idx = i * step + j;
      if (idx < data.length) {
        const val = data[idx];
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    const y1 = (1 + min) * amp;
    const y2 = (1 + max) * amp;
    if (i === 0) ctx.moveTo(i, y1);
    else ctx.lineTo(i, y1);
    ctx.lineTo(i, y2);
  }
  ctx.stroke();
}

// Генерация экспоненциального свипа
function createSweep() {
  const length = SAMPLE_RATE * SWEEP_DURATION;
  const buffer = audioCtx.createBuffer(1, length, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  
  const w1 = SWEEP_START_FREQ * 2 * Math.PI;
  const w2 = SWEEP_END_FREQ * 2 * Math.PI;
  const T = SWEEP_DURATION;
  const K = (w2 / w1);
  
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    // Формула Фарана (Farina)
    const phase = (w1 * T / Math.log(K)) * (Math.exp(t * Math.log(K) / T) - 1);
    data[i] = Math.sin(phase) * 0.5; // 0.5 чтобы не было перегруза
  }
  
  return buffer;
}

async function startMeasurement() {
  try {
    measureBtn.disabled = true;
    statusText.textContent = 'Инициализация...';
    
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    statusText.textContent = 'Запрос доступа к микрофону...';
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: SAMPLE_RATE
      }
    });

    statusText.textContent = 'Генерация сигнала...';
    const sweepBuffer = createSweep();
    const sweepSource = audioCtx.createBufferSource();
    sweepSource.buffer = sweepBuffer;
    
    // Подключаем выход к динамикам (для воспроизведения)
    sweepSource.connect(audioCtx.destination);

    // Настройка записи
    const source = audioCtx.createMediaStreamSource(stream);
    // ScriptProcessor устарел, но для MVP проще всего
    const processor = audioCtx.createScriptProcessor(4096, 1, 1); 
    
    let recordedData = [];
    
    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      recordedData.push(...inputData); // Сохраняем всё в массив
    };

    source.connect(processor);
    // ВАЖНО: Processor должен быть подключен к destination, чтобы работать в некоторых браузерах,
    // но мы не хотим слышать микрофон. Подключим к пустому GainNode.
    const muteGain = audioCtx.createGain();
    muteGain.gain.value = 0;
    processor.connect(muteGain);
    muteGain.connect(audioCtx.destination);

    statusText.textContent = 'Воспроизведение свипа и запись...';
    
    sweepSource.start();
    
    // Ждем окончания свипа + хвост 1 сек
    setTimeout(() => {
      statusText.textContent = 'Обработка...';
      // Отключаем запись
      source.disconnect();
      processor.disconnect();
      stream.getTracks().forEach(track => track.stop());

      // Рисуем записанный сигнал
      const dataArray = new Float32Array(recordedData);
      // Отсекаем тишину в начале (если есть задержка браузера)
      let startIdx = dataArray.findIndex(v => Math.abs(v) > 0.01);
      if(startIdx > 0) startIdx = Math.max(0, startIdx - 500);
      else startIdx = 0;
      
      drawWaveform(dataArray.subarray(startIdx));
      
      statusText.textContent = 'Измерение завершено';
      measureBtn.disabled = false;
    }, (SWEEP_DURATION + 1.0) * 1000);

  } catch (err) {
    console.error(err);
    statusText.textContent = 'Ошибка: ' + err.message;
    measureBtn.disabled = false;
  }
}

measureBtn.addEventListener('click', startMeasurement);