//The call, as the server sees it (docs/especificacao/09): the server learns that a call started, who is in it and when it
//ended from the people in it. This client says "I joined" / "I left" and remembers which call (session) the server put it in,
//so the recordings and the transcript can say which call they belong to.
//
//Transport-agnostic like the chat client: it talks through send() and receives the server's control message through receive().
export class CallClient {
    #send; #inCall = false; #session = null; #listeners = new Set();

    constructor({ send = () => false } = {}) { this.#send = send; }

    get inCall() { return this.#inCall; }
    get sessionId() { return this.#session?.sessionId ?? null; }
    get startedAt() { return this.#session?.startedAt ?? null; }

    onChange(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
    #emit() { for (const fn of [...this.#listeners]) { try { fn(this); } catch (error) { console.error('[call] listener failed:', error); } } }

    join() {
        if (this.#inCall) return;
        this.#inCall = true;
        this.#send({ type: 'join' });
        this.#emit();
    }

    leave() {
        if (!this.#inCall) return;
        this.#inCall = false;
        this.#session = null;
        this.#send({ type: 'leave' });
        this.#emit();
    }

    //A new connection (after a drop) is a new person to the server: say again that I am in the call
    onConnected() { if (this.#inCall) this.#send({ type: 'join' }); }

    receive(control) {
        if (control?.type !== 'call' || !this.#inCall) return;
        this.#session = { sessionId: control.sessionId, startedAt: control.startedAt };
        this.#emit();
    }
}
