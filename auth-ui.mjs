const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let rememberedEmail='', resetToken='';
const mark='<svg viewBox="0 0 64 64" width="42" height="42" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M12 26 32 14l20 12v25H12Z M21 33h22v10H21Z"/></svg>';
export const authPaths=new Set(['/login','/cadastro','/esqueci-senha','/redefinir-senha']);

async function post(path,body){
  const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Não foi possível concluir. Tente novamente.');
  return data;
}

export function renderAuth(root,{path='/login',legacyAvailable=false,passwordResetAvailable=false,onAuthenticated,onNavigate,message=''}){
  const register=path==='/cadastro',forgot=path==='/esqueci-senha',reset=path==='/redefinir-senha';
  if(reset){
    const fragment=new URLSearchParams(location.hash.slice(1));
    const query=new URLSearchParams(location.search);
    resetToken=fragment.get('token')||query.get('token')||resetToken;
    if(location.hash||location.search)history.replaceState({},'',location.pathname);
  }
  const heading=register?'criar conta':forgot?'recuperar senha':reset?'nova senha':'entrar';
  const subtitle=register?'Seu planejamento, sempre com você.':forgot?'Informe seu e-mail para receber as instruções.':reset?'Escolha uma nova senha para sua conta.':'Entre para continuar seu planejamento.';
  const passwordField=(name,label,autocomplete)=>`<label class="auth-field"><span>${label}</span><span class="password-wrap"><input name="${name}" type="password" ${autocomplete==='new-password'?'minlength="10"':''} maxlength="128" required autocomplete="${autocomplete}" aria-label="${label}"><button type="button" class="password-toggle" data-password="${name}" aria-label="Mostrar ${label}">mostrar</button></span></label>`;
  document.documentElement.dataset.theme='dark';document.title=`${heading} · meu financeiro`;
  root.innerHTML=`<main class="auth-shell"><div class="auth-brand">${mark}<span>meu financeiro</span></div><section class="auth-card"><h1 class="auth-heading">${heading}</h1><p class="auth-subtitle">${subtitle}</p><div class="auth-error" role="alert" ${message?'':'hidden'}>${escape(message)}</div><div class="auth-success" role="status" hidden></div><form class="auth-form">${register?'<label class="auth-field"><span>nome</span><input name="firstName" required maxlength="80" autocomplete="given-name"></label><label class="auth-field"><span>sobrenome</span><input name="lastName" maxlength="100" autocomplete="family-name"></label>':''}${!reset?`<label class="auth-field"><span>e-mail</span><input name="email" type="email" value="${escape(rememberedEmail)}" required maxlength="254" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false"></label>`:''}${!forgot?passwordField('password',reset?'nova senha':'senha',register||reset?'new-password':'current-password'):''}${register||reset?'<p class="auth-note">Use pelo menos 10 caracteres. Espaços e frases são permitidos.</p>'+passwordField('confirmation','repetir senha','new-password'):''}${register&&legacyAvailable?'<label class="auth-checkbox"><input name="importLegacy" type="checkbox"><span>Trazer o planejamento já salvo neste computador para minha conta.</span></label><p class="auth-note">A cópia anterior será preservada.</p>':''}${forgot&&!passwordResetAvailable?'<p class="auth-note">A recuperação por e-mail ainda não está disponível neste ambiente.</p>':''}${reset&&!resetToken?'<p class="auth-error">Abra o link de recuperação recebido por e-mail.</p>':''}<button class="button primary auth-submit" type="submit" ${(forgot&&!passwordResetAvailable)||(reset&&!resetToken)?'disabled':''}>${register?'criar conta':forgot?'enviar instruções':reset?'salvar nova senha':'entrar'}</button></form><div class="auth-links">${!register&&!forgot&&!reset?'<button type="button" data-auth-path="/esqueci-senha">esqueci minha senha</button><button type="button" data-auth-path="/cadastro">criar conta →</button>':'<button type="button" data-auth-path="/login">← voltar para entrar</button>'}</div></section><p class="auth-footer">Seu saldo. Seus planos. Um dia de cada vez.</p></main>`;
  const shell=root.querySelector('.auth-shell'),form=shell.querySelector('form'),error=shell.querySelector('.auth-error'),success=shell.querySelector('.auth-success');
  shell.addEventListener('click',e=>{
    const navigate=e.target.closest('[data-auth-path]');
    if(navigate){rememberedEmail=form.elements.email?.value||rememberedEmail;onNavigate(navigate.dataset.authPath);return;}
    const toggle=e.target.closest('[data-password]');
    if(toggle){const input=form.elements[toggle.dataset.password],show=input.type==='password';input.type=show?'text':'password';toggle.textContent=show?'ocultar':'mostrar';toggle.setAttribute('aria-label',(show?'Ocultar ':'Mostrar ')+input.getAttribute('aria-label'));}
  });
  form.addEventListener('submit',async e=>{
    e.preventDefault();e.stopPropagation();const submit=form.querySelector('[type=submit]');if(submit.disabled)return;
    const values=Object.fromEntries(new FormData(form));rememberedEmail=values.email||rememberedEmail;
    error.hidden=true;success.hidden=true;
    if((register||reset)&&values.password!==values.confirmation){error.textContent='As senhas precisam ser iguais.';error.hidden=false;return;}
    submit.disabled=true;submit.textContent='aguarde…';
    try{
      if(forgot){const result=await post('/api/auth/forgot',{email:values.email});success.textContent=result.message||'Se houver uma conta com este e-mail, você receberá as instruções.';success.hidden=false;}
      else if(reset){await post('/api/auth/reset',{token:resetToken,password:values.password});resetToken='';onNavigate('/login','Senha atualizada. Entre com sua nova senha.');return;}
      else{const result=await post(register?'/api/auth/register':'/api/auth/login',register?{email:values.email,password:values.password,firstName:values.firstName,lastName:values.lastName,importLegacy:values.importLegacy==='on'}:{email:values.email,password:values.password});form.reset();await onAuthenticated(result);return;}
    }catch(err){error.textContent=err instanceof TypeError?'Não foi possível conectar. Verifique sua conexão e tente novamente.':err.message;error.hidden=false;}
    finally{if(submit.isConnected){submit.disabled=false;submit.textContent=register?'criar conta':forgot?'enviar instruções':reset?'salvar nova senha':'entrar';}}
  });
}
